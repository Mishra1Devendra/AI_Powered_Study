import { createHash, randomUUID } from "node:crypto";
import {
  ASSISTANT_ACTION_INFO,
  NOTE_LIMITS,
  NOT_IN_NOTES_MESSAGE,
  type AssistantAction,
  type AssistantInput,
  type Conversation,
  type GroundingOutcome,
  type IndexStatus,
  type Note,
  type NoteChunk,
  type NoteFileType,
  type NoteListQuery,
  type PasteNoteInput,
  type SourceRef,
  type TutorMessage,
} from "@copilot/shared";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { toIndexStatus } from "../knowledge/status.js";
import type { LLMProvider } from "../services/ai/index.js";
import { buildNotesPrompt } from "../services/ai/notes/prompt.js";
import { collapseRegenerations } from "../services/ai/tutor/history.js";
import type { TutorRepository } from "../tutor/repository.js";
import { DEFAULT_REPLY_DEADLINE_MS, createGenerationLock, createTurn, type Turn } from "../tutor/turn.js";
import { chunkPages } from "./chunker.js";
import { extractDocument } from "./extract.js";
import { NoteFileError, detectFile, sanitizeFilename, titleFromFilename } from "./file-validation.js";
import { normalizeText } from "./normalize.js";
import { ProcessingError } from "./processing-error.js";
import type { NotesRepository, OutlineItem } from "./repository.js";
import { selectContext } from "./retrieval.js";
import { StorageError, storagePathFor, type NotesStorage } from "./storage.js";

/** A note stuck "uploading"/"processing" for longer than this is shown as failed and may be retried. */
const STALE_AFTER_MS = 2 * 60_000;
const HISTORY_FETCH_LIMIT = 40;
const DETAIL_MESSAGE_LIMIT = 200;

export class DuplicateNoteError extends AppError {
  constructor(existing: Note) {
    super(409, "duplicate_note", `You already uploaded this as "${existing.title}".`, { noteId: existing.id });
    this.name = "DuplicateNoteError";
  }
}

export interface NotesServiceOptions {
  repo: NotesRepository;
  tutorRepo: TutorRepository;
  storage: NotesStorage;
  ai: LLMProvider;
  /** Phase 11: lets the assistant tell "this is not in your document" from "answer from the document". */
  knowledge?: KnowledgeService | undefined;
  replyDeadlineMs?: number;
  onError?: (err: unknown) => void;
  /** Overridable for tests. */
  now?: () => number;
}

const isUniqueViolation = (err: unknown): boolean => {
  const code = (e: unknown) => (e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : undefined);
  const cause = err && typeof err === "object" && "cause" in err ? (err as { cause: unknown }).cause : undefined;
  return code(err) === "23505" || code(cause) === "23505";
};

export function createNotesService({ repo, tutorRepo, storage, ai, knowledge, replyDeadlineMs = DEFAULT_REPLY_DEADLINE_MS, onError, now = Date.now }: NotesServiceOptions) {
  const acquireConversation = createGenerationLock("The assistant is still answering. Please wait a moment.");
  const processing = new Set<string>();

  /** What the student sees: a run that never finished is reported as failed (and can be retried). */
  function present(note: Note): Note {
    const stuck = (note.status === "uploading" || note.status === "processing") && now() - Date.parse(note.updatedAt) > STALE_AFTER_MS;
    const shown: Note = stuck ? { ...note, status: "failed", error: "Processing did not finish. Try again." } : note;
    return { ...shown, indexed: shown.status === "ready" && shown.chunkCount > 0 };
  }

  async function requireNote(userId: string, id: string): Promise<Note> {
    // Ownership: the query filters by the verified user id AND Row Level Security applies.
    // Someone else's note is indistinguishable from one that does not exist.
    const note = await repo.getNote(userId, id);
    if (!note) throw new NotFoundError("Note not found.");
    return present(note);
  }

  /** Extract -> clean -> chunk -> store. Never throws for a bad document: it marks it failed with a reason. */
  async function runProcessing(userId: string, id: string, bytes: Uint8Array, fileType: NoteFileType, filename: string): Promise<void> {
    if (processing.has(id)) return;
    processing.add(id);
    try {
      await repo.setStatus(userId, id, { status: "processing" });
      const extracted = await extractDocument(bytes, fileType);
      const pages = extracted.pages
        .map((p) => ({ page: p.page, text: normalizeText(p.text, { unwrap: fileType === "pdf" }) }))
        .filter((p) => p.text.length > 0);
      if (pages.length === 0) throw new ProcessingError("No readable text was found in this file.");
      const chunks = chunkPages(pages);
      if (chunks.length === 0) throw new ProcessingError("No readable text was found in this file.");
      await repo.saveChunksAndMarkReady(userId, id, chunks, {
        pageCount: extracted.pageCount,
        charCount: pages.reduce((n, p) => n + p.text.length, 0),
        sourceFilename: filename,
      });
    } catch (err) {
      const message = err instanceof ProcessingError ? err.message : "Something went wrong while processing this file. Please try again.";
      if (!(err instanceof ProcessingError)) onError?.(err);
      await repo.setStatus(userId, id, { status: "failed", error: message });
    } finally {
      processing.delete(id);
    }
  }

  /** Shared by file upload and pasted text. */
  async function ingest(args: {
    userId: string;
    accessToken: string;
    filename: string;
    bytes: Uint8Array;
    source: "upload" | "paste";
    title?: string | undefined;
  }): Promise<Note> {
    const { userId, accessToken, filename, bytes, source } = args;
    const detected = detectFile(bytes, filename); // throws NoteFileError (400 / 413 / 415)
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    const existing = await repo.findActiveByHash(userId, contentHash);
    if (existing) throw new DuplicateNoteError(existing);

    const id = randomUUID();
    const storagePath = storagePathFor(userId, id, detected.fileType); // server-generated, never from user input
    let note: Note;
    try {
      note = await repo.createDocument({
        id,
        userId,
        title: (args.title?.trim() || titleFromFilename(filename)).slice(0, NOTE_LIMITS.titleMaxChars),
        originalFilename: filename,
        fileType: detected.fileType,
        source,
        mimeType: detected.mime,
        fileSize: bytes.length,
        contentHash,
        storagePath,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Two identical uploads raced; the unique index kept the first.
        const winner = await repo.findActiveByHash(userId, contentHash);
        if (winner) throw new DuplicateNoteError(winner);
      }
      throw err;
    }

    try {
      await storage.upload(accessToken, storagePath, bytes, detected.mime);
    } catch (err) {
      // Nothing was stored, so there is nothing to retry from: hide the empty record and report the failure.
      onError?.(err);
      await repo.softDelete(userId, id);
      throw new AppError(502, "storage_failed", err instanceof StorageError && err.status === 0 ? "File storage is unreachable. Please try again." : "Could not store your file. Please try again.");
    }

    await runProcessing(userId, id, bytes, detected.fileType, filename);
    return present((await repo.getNote(userId, id)) ?? note);
  }

  /** Builds the Turn for one assistant reply. */
  function makeAssistantTurn(args: {
    userId: string;
    note: Note;
    conversation: Conversation;
    studentName: string | null;
    action: AssistantAction;
    message: string;
    history: TutorMessage[];
    leadingEvent: Parameters<typeof createTurn>[0]["leadingEvent"];
    release: () => void;
  }): Turn {
    const { userId, note, conversation, studentName, action, message, history, leadingEvent, release } = args;
    let refs: SourceRef[] = [];
    let outcome: GroundingOutcome | undefined;
    return createTurn({
      ai,
      replyDeadlineMs,
      onError,
      leadingEvent,
      release,
      buildPrompt: async () => {
        const previous = [...collapseRegenerations(history)].reverse().find((m) => m.role === "assistant" && m.sources?.length);
        // A question the document does not answer gets a plain "not in your notes" reply instead of a guess (no AI call).
        if (knowledge && action === "ask") {
          const found = await knowledge.retrieveRelevantChunks(userId, { query: message, documentId: note.id });
          if (found.keywords.length > 0 && !found.relevant && (found.keywords.length > 2 || !previous)) {
            refs = [];
            outcome = "not_found";
            return { fixed: NOT_IN_NOTES_MESSAGE };
          }
        }
        const ctx = await selectContext({
          repo,
          userId,
          documentId: note.id,
          chunkCount: note.chunkCount,
          action,
          query: message,
          previousChunkIndexes: previous?.sources?.map((s) => s.chunkIndex) ?? [],
        });
        refs = ctx.refs.map((r) => ({ ...r, documentId: note.id, documentTitle: note.title }));
        outcome = refs.length > 0 ? "grounded" : undefined;
        return buildNotesPrompt({ title: note.title, studentName, action, sources: ctx.sources, coverage: ctx.coverage, history, message });
      },
      save: async (reply) => {
        const saved = await tutorRepo.addAssistantMessage(userId, conversation.id, { ...reply, sources: refs, ...(outcome ? { grounding: outcome } : {}) });
        await repo.touchActivity(userId, note.id);
        return { message: saved, conversation };
      },
    });
  }

  async function readyNote(userId: string, id: string): Promise<Note> {
    const note = await requireNote(userId, id);
    if (note.status !== "ready") throw new ConflictError("This note is not ready yet.");
    return note;
  }

  return {
    async uploadFile(userId: string, accessToken: string, file: { filename: string; bytes: Uint8Array }): Promise<Note> {
      return ingest({ userId, accessToken, filename: sanitizeFilename(file.filename), bytes: file.bytes, source: "upload" });
    },

    async uploadText(userId: string, accessToken: string, input: PasteNoteInput): Promise<Note> {
      const text = input.text.trim();
      const firstLine = text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim().slice(0, 80);
      return ingest({
        userId,
        accessToken,
        filename: "pasted-text.txt",
        bytes: new TextEncoder().encode(text),
        source: "paste",
        title: input.title?.trim() || firstLine || "Pasted notes",
      });
    },

    async list(userId: string, query: NoteListQuery): Promise<Note[]> {
      return (await repo.listNotes(userId, query)).map(present);
    },

    async detail(userId: string, id: string): Promise<{ note: Note; outline: OutlineItem[] }> {
      const note = await requireNote(userId, id);
      return { note, outline: note.status === "ready" ? await repo.getOutline(userId, id) : [] };
    },

    /** How ready the document is for AI questions (real state; the search method is keyword, not vector). */
    async indexStatus(userId: string, id: string): Promise<IndexStatus> {
      return toIndexStatus(await requireNote(userId, id));
    },

    async content(userId: string, id: string, cursor: number, limit: number): Promise<{ chunks: NoteChunk[]; nextCursor: number | null; total: number }> {
      const note = await readyNote(userId, id);
      const rows = await repo.getContentPage(userId, id, cursor, limit + 1);
      const chunks = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? rows[limit]!.index : null;
      await repo.touchActivity(userId, id);
      return { chunks, nextCursor, total: note.chunkCount };
    },

    async remove(userId: string, id: string): Promise<void> {
      // Soft delete only: the row, chunks and original file are retained (project data policy).
      if (!(await repo.softDelete(userId, id))) throw new NotFoundError("Note not found.");
    },

    /** Re-runs processing for a failed (or stuck) note from its stored original file. */
    async retry(userId: string, accessToken: string, id: string): Promise<Note> {
      const note = await requireNote(userId, id);
      if (note.status === "ready") throw new ConflictError("This note is already processed.");
      if (note.status !== "failed") throw new ConflictError("This note is still being processed.");
      const info = await repo.getStorageInfo(userId, id);
      if (!info) throw new NotFoundError("Note not found.");
      let bytes: Uint8Array;
      try {
        bytes = await storage.download(accessToken, info.storagePath);
      } catch (err) {
        onError?.(err);
        await repo.setStatus(userId, id, { status: "failed", error: "The stored file could not be read. Please upload it again." });
        return present((await repo.getNote(userId, id)) ?? note);
      }
      let detected;
      try {
        detected = detectFile(bytes, `file.${info.fileType}`);
      } catch (err) {
        const message = err instanceof NoteFileError ? err.message : "The stored file is not valid.";
        await repo.setStatus(userId, id, { status: "failed", error: message });
        return present((await repo.getNote(userId, id)) ?? note);
      }
      await runProcessing(userId, id, bytes, detected.fileType, note.originalFilename);
      return present((await repo.getNote(userId, id)) ?? note);
    },

    /** The document's assistant chat so far (empty until the first question). */
    async conversation(userId: string, id: string): Promise<{ conversation: Conversation | null; messages: TutorMessage[] }> {
      await requireNote(userId, id);
      const conversation = await repo.findConversation(userId, id);
      if (!conversation) return { conversation: null, messages: [] };
      const messages = await tutorRepo.listMessages(userId, conversation.id, DETAIL_MESSAGE_LIMIT);
      return { conversation, messages: collapseRegenerations(messages) };
    },

    /** Saves the student's request and returns a Turn that streams the grounded answer. */
    async startAssistant(userId: string, id: string, input: AssistantInput): Promise<Turn> {
      const note = await readyNote(userId, id);
      const conversation = await repo.getOrCreateConversation(userId, id, `Notes: ${note.title}`);
      const release = acquireConversation(conversation.id);
      try {
        const [studentName, history] = await Promise.all([
          tutorRepo.getStudentName(userId),
          tutorRepo.listMessages(userId, conversation.id, HISTORY_FETCH_LIMIT),
        ]);
        const message = input.question?.trim() || ASSISTANT_ACTION_INFO[input.action].defaultMessage;
        const userMessage = await tutorRepo.addUserMessage(userId, conversation.id, { content: message, action: input.action });
        return makeAssistantTurn({
          userId,
          note,
          conversation,
          studentName,
          action: input.action,
          message,
          history,
          leadingEvent: { type: "user_message", message: userMessage },
          release,
        });
      } catch (err) {
        release();
        throw err;
      }
    },

    /** New answer to the latest request (Retry / Regenerate). Append-only, like the tutor. */
    async regenerateAssistant(userId: string, id: string): Promise<Turn> {
      const note = await readyNote(userId, id);
      const conversation = await repo.findConversation(userId, id);
      if (!conversation) throw new BadRequestError("There is nothing to answer yet.");
      const release = acquireConversation(conversation.id);
      try {
        const [studentName, all] = await Promise.all([
          tutorRepo.getStudentName(userId),
          tutorRepo.listMessages(userId, conversation.id, HISTORY_FETCH_LIMIT),
        ]);
        const lastUserIndex = all.map((m) => m.role).lastIndexOf("user");
        if (lastUserIndex === -1) throw new BadRequestError("There is nothing to answer yet.");
        const lastUser = all[lastUserIndex]!;
        const action = (lastUser.action as AssistantAction | null | undefined) ?? "ask";
        return makeAssistantTurn({
          userId,
          note,
          conversation,
          studentName,
          action,
          message: lastUser.content,
          history: all.slice(0, lastUserIndex),
          leadingEvent: null,
          release,
        });
      } catch (err) {
        release();
        throw err;
      }
    },
  };
}

export type NotesService = ReturnType<typeof createNotesService>;
