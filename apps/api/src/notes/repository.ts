import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Conversation, Note, NoteChunk, NoteFileType, NoteListQuery, NoteStatus } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { documentChunks, documents } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";
import { rawToConversation, type RawConversationRow } from "../tutor/repository.js";
import type { DocChunk } from "./chunker.js";

export interface NewDocument {
  id: string;
  userId: string;
  title: string;
  originalFilename: string;
  fileType: NoteFileType;
  source: "upload" | "paste";
  mimeType: string;
  fileSize: number;
  contentHash: string;
  storagePath: string;
}

export interface StatusPatch {
  status: NoteStatus;
  error?: string | null;
}

export interface StorageInfo {
  storagePath: string;
  fileType: NoteFileType;
  status: NoteStatus;
  /** ISO time of the last status change (used to detect a processing run that never finished). */
  updatedAt: string;
}

/** A piece of a document returned for retrieval. */
export interface ChunkHit {
  chunkIndex: number;
  content: string;
  page: number | null;
  heading: string | null;
}

export interface OutlineItem {
  chunkIndex: number;
  heading: string;
  page: number | null;
}

/**
 * Persistence for AI Notes.
 *
 * Reads and student edits run through `withUser` (Row Level Security as the signed-in student).
 * The processing lifecycle - creating the record, status, chunks - is written by the server only,
 * after it has resolved the student from the verified token; the composite foreign keys and the
 * storage-path CHECK make it impossible to attach rows to another student's data.
 */
export interface NotesRepository {
  createDocument(doc: NewDocument): Promise<Note>;
  findActiveByHash(userId: string, contentHash: string): Promise<Note | null>;
  getNote(userId: string, id: string): Promise<Note | null>;
  getStorageInfo(userId: string, id: string): Promise<StorageInfo | null>;
  listNotes(userId: string, query: NoteListQuery): Promise<Note[]>;
  setStatus(userId: string, id: string, patch: StatusPatch): Promise<void>;
  /** Stores every chunk and marks the document ready in ONE transaction (all or nothing). */
  saveChunksAndMarkReady(
    userId: string,
    id: string,
    chunks: DocChunk[],
    summary: { pageCount: number | null; charCount: number; sourceFilename: string },
  ): Promise<void>;
  getOutline(userId: string, id: string): Promise<OutlineItem[]>;
  getContentPage(userId: string, id: string, cursor: number, limit: number): Promise<NoteChunk[]>;
  /** Soft delete: hides the note; the row, chunks and stored file are retained. */
  softDelete(userId: string, id: string): Promise<boolean>;
  touchActivity(userId: string, id: string): Promise<void>;
  /** Full-text retrieval of the best-matching chunks for the given search words. */
  searchChunks(userId: string, id: string, words: string[], limit: number): Promise<ChunkHit[]>;
  getChunks(userId: string, id: string, indexes: number[]): Promise<ChunkHit[]>;
  /** The document's assistant conversation, if one exists yet (read-only). */
  findConversation(userId: string, id: string): Promise<Conversation | null>;
  /** One assistant conversation per document, created on first use. */
  getOrCreateConversation(userId: string, id: string, title: string): Promise<Conversation>;
}

type DocRow = typeof documents.$inferSelect;
type ChunkRow = typeof documentChunks.$inferSelect;

export const toNote = (r: DocRow): Note => ({
  id: r.id,
  title: r.title,
  originalFilename: r.originalFilename,
  fileType: r.fileType as NoteFileType,
  source: r.source as "upload" | "paste",
  fileSize: r.fileSize,
  status: r.processingStatus as NoteStatus,
  error: r.processingError,
  pageCount: r.pageCount,
  chunkCount: r.chunkCount,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  lastActivityAt: r.lastActivityAt.toISOString(),
});

interface ChunkMeta {
  page?: number | null;
  pageEnd?: number | null;
  heading?: string | null;
}
const meta = (m: unknown): ChunkMeta => (m && typeof m === "object" ? (m as ChunkMeta) : {});

const toChunk = (r: Pick<ChunkRow, "chunkIndex" | "content" | "metadata">): NoteChunk => {
  const m = meta(r.metadata);
  return { index: r.chunkIndex, page: m.page ?? null, pageEnd: m.pageEnd ?? m.page ?? null, heading: m.heading ?? null, content: r.content };
};
const toHit = (r: Pick<ChunkRow, "chunkIndex" | "content" | "metadata">): ChunkHit => {
  const m = meta(r.metadata);
  return { chunkIndex: r.chunkIndex, content: r.content, page: m.page ?? null, heading: m.heading ?? null };
};

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const BATCH = 100;

export function createNotesRepository(db: Database): NotesRepository {
  const mine = (userId: string, id: string) => and(eq(documents.id, id), eq(documents.userId, userId), isNull(documents.deletedAt));

  return {
    async createDocument(doc) {
      const [row] = await db
        .insert(documents)
        .values({ ...doc, processingStatus: "uploading" })
        .returning();
      return toNote(row!);
    },

    async findActiveByHash(userId, contentHash) {
      const [row] = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(documents)
          .where(and(eq(documents.userId, userId), eq(documents.contentHash, contentHash), isNull(documents.deletedAt))),
      );
      return row ? toNote(row) : null;
    },

    async getNote(userId, id) {
      const [row] = await withUser(db, userId, (tx) => tx.select().from(documents).where(mine(userId, id)));
      return row ? toNote(row) : null;
    },

    async getStorageInfo(userId, id) {
      const [row] = await withUser(db, userId, (tx) =>
        tx
          .select({ storagePath: documents.storagePath, fileType: documents.fileType, status: documents.processingStatus, updatedAt: documents.updatedAt })
          .from(documents)
          .where(mine(userId, id)),
      );
      return row ? { storagePath: row.storagePath, fileType: row.fileType as NoteFileType, status: row.status as NoteStatus, updatedAt: row.updatedAt.toISOString() } : null;
    },

    async listNotes(userId, query) {
      const filters = [eq(documents.userId, userId), isNull(documents.deletedAt)];
      if (query.type) filters.push(eq(documents.fileType, query.type));
      if (query.status) filters.push(eq(documents.processingStatus, query.status));
      if (query.q) {
        const p = likePattern(query.q);
        filters.push(or(ilike(documents.title, p), ilike(documents.originalFilename, p))!);
      }
      const order = {
        recent: desc(documents.createdAt),
        oldest: asc(documents.createdAt),
        name: asc(sql`lower(${documents.title})`),
        activity: desc(documents.lastActivityAt),
      }[query.sort];
      const rows = await withUser(db, userId, (tx) =>
        tx.select().from(documents).where(and(...filters)).orderBy(order).limit(query.limit),
      );
      return rows.map(toNote);
    },

    async setStatus(userId, id, patch) {
      await db
        .update(documents)
        .set({ processingStatus: patch.status, processingError: patch.error ?? null })
        .where(and(eq(documents.id, id), eq(documents.userId, userId)));
    },

    async saveChunksAndMarkReady(userId, id, chunks, summary) {
      await db.transaction(async (tx) => {
        for (let i = 0; i < chunks.length; i += BATCH) {
          await tx.insert(documentChunks).values(
            chunks.slice(i, i + BATCH).map((c) => ({
              documentId: id,
              userId,
              chunkIndex: c.index,
              content: c.content,
              charCount: c.content.length,
              metadata: { page: c.page, pageEnd: c.pageEnd, heading: c.heading, headingPath: c.headingPath, source: summary.sourceFilename },
            })),
          );
        }
        await tx
          .update(documents)
          .set({
            processingStatus: "ready",
            processingError: null,
            pageCount: summary.pageCount,
            chunkCount: chunks.length,
            charCount: summary.charCount,
          })
          .where(and(eq(documents.id, id), eq(documents.userId, userId)));
      });
    },

    async getOutline(userId, id) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({ chunkIndex: documentChunks.chunkIndex, metadata: documentChunks.metadata })
          .from(documentChunks)
          .where(and(eq(documentChunks.documentId, id), eq(documentChunks.userId, userId)))
          .orderBy(asc(documentChunks.chunkIndex)),
      );
      const outline: OutlineItem[] = [];
      for (const r of rows) {
        const m = meta(r.metadata);
        // One entry per heading (the first chunk that starts it).
        if (m.heading && outline[outline.length - 1]?.heading !== m.heading) {
          outline.push({ chunkIndex: r.chunkIndex, heading: m.heading, page: m.page ?? null });
        }
      }
      return outline;
    },

    async getContentPage(userId, id, cursor, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, metadata: documentChunks.metadata })
          .from(documentChunks)
          .where(and(eq(documentChunks.documentId, id), eq(documentChunks.userId, userId), gte(documentChunks.chunkIndex, cursor)))
          .orderBy(asc(documentChunks.chunkIndex))
          .limit(limit),
      );
      return rows.map(toChunk);
    },

    async softDelete(userId, id) {
      const rows = await withUser(db, userId, (tx) =>
        tx.update(documents).set({ deletedAt: new Date() }).where(mine(userId, id)).returning({ id: documents.id }),
      );
      return rows.length > 0;
    },

    async touchActivity(userId, id) {
      await withUser(db, userId, (tx) => tx.update(documents).set({ lastActivityAt: new Date() }).where(mine(userId, id)));
    },

    async searchChunks(userId, id, words, limit) {
      // Words are reduced to letters/digits by the caller, so this OR-query can never be malformed.
      const query = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join(" | ");
      if (!query) return [];
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ chunk_index: number; content: string; metadata: unknown }>(sql`
          select c.chunk_index, c.content, c.metadata
          from public.document_chunks c, to_tsquery('english', ${query}) q
          where c.document_id = ${id} and c.user_id = ${userId} and c.search_tsv @@ q
          order by ts_rank_cd(c.search_tsv, q) desc, c.chunk_index asc
          limit ${limit}`),
      );
      return rows.map((r) => toHit({ chunkIndex: r.chunk_index, content: r.content, metadata: r.metadata }));
    },

    async getChunks(userId, id, indexes) {
      if (indexes.length === 0) return [];
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, metadata: documentChunks.metadata })
          .from(documentChunks)
          .where(
            and(
              eq(documentChunks.documentId, id),
              eq(documentChunks.userId, userId),
              inArray(documentChunks.chunkIndex, indexes.map((n) => Math.trunc(n))),
            ),
          )
          .orderBy(asc(documentChunks.chunkIndex)),
      );
      return rows.map(toHit);
    },

    async findConversation(userId, id) {
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<RawConversationRow>(sql`
          select id, title, subject, topic, level, created_at, updated_at
          from public.conversations
          where user_id = ${userId} and document_id = ${id} and deleted_at is null
          limit 1`),
      );
      return rows[0] ? rawToConversation(rows[0]) : null;
    },

    async getOrCreateConversation(userId, id, title) {
      const find = () => this.findConversation(userId, id);
      const existing = await find();
      if (existing) return existing;
      try {
        const rows = await withUser(db, userId, (tx) =>
          tx.execute<RawConversationRow>(sql`
            insert into public.conversations (user_id, title, document_id)
            values (${userId}, ${title.slice(0, 120) || "Notes"}, ${id})
            returning id, title, subject, topic, level, created_at, updated_at`),
        );
        return rawToConversation(rows[0]!);
      } catch (err) {
        // Two requests raced: the partial unique index kept one. Use it.
        const again = await find();
        if (again) return again;
        throw err;
      }
    },
  };
}
