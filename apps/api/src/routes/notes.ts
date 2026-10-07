import multipart from "@fastify/multipart";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  NOTE_LIMITS,
  assistantInputSchema,
  noteContentQuerySchema,
  noteIdParamSchema,
  noteListQuerySchema,
  pasteNoteInputSchema,
} from "@copilot/shared";
import { BadRequestError } from "../errors.js";
import { NoteFileError } from "../notes/file-validation.js";
import type { NotesService } from "../notes/service.js";
import { GENERATION_RATE_LIMIT, streamTurn } from "./sse.js";

interface Deps {
  service: NotesService;
  authenticate: preHandlerAsyncHookHandler;
}

/** Uploads are heavier than chat messages (storage + parsing): a tighter per-client cap. */
const UPLOAD_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
/** The file plus multipart overhead; the multipart parser enforces the real per-file limit. */
const UPLOAD_BODY_LIMIT = NOTE_LIMITS.maxFileBytes + 256 * 1024;
const PASTE_BODY_LIMIT = NOTE_LIMITS.maxPastedChars * 4 + 4096; // up to 4 bytes per character in UTF-8
const ASK_BODY_LIMIT = 8 * 1024;

export async function notesRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  // Scoped to this plugin: only the notes routes accept multipart bodies.
  await app.register(multipart, {
    limits: { fileSize: NOTE_LIMITS.maxFileBytes, files: 1, fields: 2, parts: 4, fieldSize: 1024, headerPairs: 50 },
  });

  const base = "/api/notes";

  // Upload a file (PDF / TXT / Markdown). The student, file type and storage path are all
  // resolved on the server: nothing about identity or location is taken from the request body.
  app.post(base, { preHandler: authenticate, bodyLimit: UPLOAD_BODY_LIMIT, config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (req, reply) => {
    if (!req.isMultipart()) throw new NoteFileError(415, "unsupported_type", "Send the file as multipart form data.");
    const part = await req.file();
    if (!part) throw new BadRequestError("No file was uploaded.");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await part.toBuffer());
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new NoteFileError(413, "file_too_large", `This file is larger than ${NOTE_LIMITS.maxFileBytes / (1024 * 1024)} MB.`);
      }
      throw new BadRequestError("The upload could not be read. Please try again.");
    }
    const note = await service.uploadFile(req.user!.id, req.accessToken!, { filename: part.filename, bytes });
    return reply.status(201).send({ note });
  });

  // Paste text instead of uploading a file.
  app.post(`${base}/text`, { preHandler: authenticate, bodyLimit: PASTE_BODY_LIMIT, config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (req, reply) => {
    const input = pasteNoteInputSchema.parse(req.body);
    const note = await service.uploadText(req.user!.id, req.accessToken!, input);
    return reply.status(201).send({ note });
  });

  app.get(base, { preHandler: authenticate }, async (req) => ({
    notes: await service.list(req.user!.id, noteListQuerySchema.parse(req.query)),
  }));

  app.get(`${base}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = noteIdParamSchema.parse(req.params);
    return service.detail(req.user!.id, id);
  });

  // Phase 11: is the document searchable by the AI yet? (Derived from its real processing state.)
  app.get(`${base}/:id/index-status`, { preHandler: authenticate }, async (req) => {
    const { id } = noteIdParamSchema.parse(req.params);
    return { index: await service.indexStatus(req.user!.id, id) };
  });

  // Extracted text, a page of chunks at a time (never the whole document).
  app.get(`${base}/:id/content`, { preHandler: authenticate }, async (req) => {
    const { id } = noteIdParamSchema.parse(req.params);
    const { cursor, limit } = noteContentQuerySchema.parse(req.query);
    return service.content(req.user!.id, id, cursor, limit);
  });

  // Retry processing of a failed note from its stored original.
  app.post(`${base}/:id/process`, { preHandler: authenticate, config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (req) => {
    const { id } = noteIdParamSchema.parse(req.params);
    return { note: await service.retry(req.user!.id, req.accessToken!, id) };
  });

  // Soft delete: hides the note; the file, text and chunks are retained.
  app.delete(`${base}/:id`, { preHandler: authenticate }, async (req, reply) => {
    const { id } = noteIdParamSchema.parse(req.params);
    await service.remove(req.user!.id, id);
    return reply.status(204).send();
  });

  app.get(`${base}/:id/conversation`, { preHandler: authenticate }, async (req) => {
    const { id } = noteIdParamSchema.parse(req.params);
    return service.conversation(req.user!.id, id);
  });

  // Ask the document-grounded assistant (explain / summarize / flashcards / quiz / ask ...). Streams the answer.
  app.post(
    `${base}/:id/assistant`,
    { preHandler: [authenticate, app.aiQuota.guard("notes")], bodyLimit: ASK_BODY_LIMIT, config: { rateLimit: GENERATION_RATE_LIMIT } },
    async (req, reply) => {
      const { id } = noteIdParamSchema.parse(req.params);
      const input = assistantInputSchema.parse(req.body);
      const turn = await service.startAssistant(req.user!.id, id, input);
      await streamTurn(req, reply, turn);
    },
  );

  app.post(
    `${base}/:id/assistant/regenerate`,
    { preHandler: [authenticate, app.aiQuota.guard("notes")], bodyLimit: 1024, config: { rateLimit: GENERATION_RATE_LIMIT } },
    async (req, reply) => {
      const { id } = noteIdParamSchema.parse(req.params);
      const turn = await service.regenerateAssistant(req.user!.id, id);
      await streamTurn(req, reply, turn);
    },
  );
}
