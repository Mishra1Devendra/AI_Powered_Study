import { randomUUID } from "node:crypto";
import type { Conversation, Note, NoteChunk } from "@copilot/shared";
import type { createInMemoryTutorRepository } from "../../tutor/testing.js";
import type { DocChunk } from "../chunker.js";
import type { ChunkHit, NewDocument, NotesRepository, OutlineItem } from "../repository.js";
import { StorageError, type NotesStorage } from "../storage.js";

interface Doc {
  note: Note;
  userId: string;
  storagePath: string;
  contentHash: string;
  deletedAt: string | null;
  chunks: NoteChunk[];
}

/**
 * In-memory NotesRepository for unit tests. Every lookup is scoped by user id (like the real one),
 * so service/route tests exercise isolation logic without a database. Real database isolation and
 * SQL behaviour are covered by the live RLS integration tests.
 */
export function createInMemoryNotesRepository(tutorStore: ReturnType<typeof createInMemoryTutorRepository>) {
  const docs = new Map<string, Doc>();
  let tick = 0;
  /** Settable clock so tests can age a record (increase `skew` to make time pass). */
  const clock = { skew: 0, now: (): number => Date.UTC(2026, 9, 3, 12, 0, 0) + ++tick * 1000 + clock.skew };
  const stamp = () => new Date(clock.now()).toISOString();
  const own = (userId: string, id: string) => {
    const d = docs.get(id);
    return d && d.userId === userId && !d.deletedAt ? d : null;
  };

  const repo: NotesRepository = {
    async createDocument(input: NewDocument) {
      const t = stamp();
      const note: Note = {
        id: input.id,
        title: input.title,
        originalFilename: input.originalFilename,
        fileType: input.fileType,
        source: input.source,
        fileSize: input.fileSize,
        status: "uploading",
        error: null,
        pageCount: null,
        chunkCount: 0,
        createdAt: t,
        updatedAt: t,
        lastActivityAt: t,
      };
      // Mirrors the unique index on (user_id, content_hash) for active documents.
      for (const d of docs.values()) {
        if (d.userId === input.userId && d.contentHash === input.contentHash && !d.deletedAt) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
      }
      docs.set(input.id, { note, userId: input.userId, storagePath: input.storagePath, contentHash: input.contentHash, deletedAt: null, chunks: [] });
      return { ...note };
    },
    async findActiveByHash(userId, hash) {
      for (const d of docs.values()) if (d.userId === userId && d.contentHash === hash && !d.deletedAt) return { ...d.note };
      return null;
    },
    async getNote(userId, id) {
      const d = own(userId, id);
      return d ? { ...d.note } : null;
    },
    async getStorageInfo(userId, id) {
      const d = own(userId, id);
      return d ? { storagePath: d.storagePath, fileType: d.note.fileType, status: d.note.status, updatedAt: d.note.updatedAt } : null;
    },
    async listNotes(userId, q) {
      let list = [...docs.values()].filter((d) => d.userId === userId && !d.deletedAt).map((d) => d.note);
      if (q.type) list = list.filter((n) => n.fileType === q.type);
      if (q.status) list = list.filter((n) => n.status === q.status);
      if (q.q) {
        const needle = q.q.toLowerCase();
        list = list.filter((n) => n.title.toLowerCase().includes(needle) || n.originalFilename.toLowerCase().includes(needle));
      }
      const by = {
        recent: (a: Note, b: Note) => b.createdAt.localeCompare(a.createdAt),
        oldest: (a: Note, b: Note) => a.createdAt.localeCompare(b.createdAt),
        name: (a: Note, b: Note) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
        activity: (a: Note, b: Note) => b.lastActivityAt.localeCompare(a.lastActivityAt),
      }[q.sort];
      return list.sort(by).slice(0, q.limit).map((n) => ({ ...n }));
    },
    async setStatus(userId, id, patch) {
      const d = docs.get(id);
      if (!d || d.userId !== userId) return;
      d.note = { ...d.note, status: patch.status, error: patch.error ?? null, updatedAt: stamp() };
    },
    async saveChunksAndMarkReady(userId, id, chunks: DocChunk[], summary) {
      const d = docs.get(id);
      if (!d || d.userId !== userId) throw new Error("FK violation: document not owned");
      if (d.chunks.length > 0) throw new Error("duplicate key: chunks already stored");
      d.chunks = chunks.map((c) => ({ index: c.index, page: c.page, pageEnd: c.pageEnd, heading: c.heading, content: c.content }));
      d.note = { ...d.note, status: "ready", error: null, pageCount: summary.pageCount, chunkCount: chunks.length, updatedAt: stamp() };
    },
    async getOutline(userId, id): Promise<OutlineItem[]> {
      const d = own(userId, id);
      if (!d) return [];
      const out: OutlineItem[] = [];
      for (const c of d.chunks) if (c.heading && out[out.length - 1]?.heading !== c.heading) out.push({ chunkIndex: c.index, heading: c.heading, page: c.page });
      return out;
    },
    async getContentPage(userId, id, cursor, limit) {
      const d = own(userId, id);
      return d ? d.chunks.filter((c) => c.index >= cursor).slice(0, limit) : [];
    },
    async softDelete(userId, id) {
      const d = own(userId, id);
      if (!d) return false;
      d.deletedAt = stamp();
      return true;
    },
    async touchActivity(userId, id) {
      const d = own(userId, id);
      if (d) d.note = { ...d.note, lastActivityAt: stamp() };
    },
    async searchChunks(userId, id, words, limit): Promise<ChunkHit[]> {
      const d = own(userId, id);
      if (!d) return [];
      return d.chunks
        .map((c) => ({ c, score: words.filter((w) => c.content.toLowerCase().includes(w.toLowerCase())).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.c.index - b.c.index)
        .slice(0, limit)
        .map(({ c }) => ({ chunkIndex: c.index, content: c.content, page: c.page, heading: c.heading }));
    },
    async getChunks(userId, id, indexes): Promise<ChunkHit[]> {
      const d = own(userId, id);
      if (!d) return [];
      return d.chunks.filter((c) => indexes.includes(c.index)).map((c) => ({ chunkIndex: c.index, content: c.content, page: c.page, heading: c.heading }));
    },
    async findConversation(userId, id): Promise<Conversation | null> {
      const d = own(userId, id);
      if (!d) return null;
      for (const c of tutorStore.convs.values()) {
        if (c.userId === userId && c.documentId === id && !c.deletedAt) {
          const { userId: _u, deletedAt: _d, documentId: _doc, ...rest } = c;
          return rest;
        }
      }
      return null;
    },
    async getOrCreateConversation(userId, id, title) {
      const existing = await repo.findConversation(userId, id);
      if (existing) return existing;
      if (!own(userId, id)) throw new Error("FK violation: document not owned");
      const t = stamp();
      const c = { id: randomUUID(), userId, deletedAt: null, documentId: id, title, subject: null, topic: null, level: null, createdAt: t, updatedAt: t };
      tutorStore.convs.set(c.id, c);
      const { userId: _u, deletedAt: _d, documentId: _doc, ...rest } = c;
      return rest;
    },
  };

  return { repo, docs, clock };
}

/**
 * Fake private storage. Like the real bucket policy, a student can only write or read inside
 * their OWN folder: the token (`token:<userId>`) must match the first path segment.
 */
export function createFakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const calls: Array<{ op: "upload" | "download"; path: string; token: string }> = [];
  const failures = { upload: null as null | StorageError, download: null as null | StorageError };
  const owner = (token: string) => token.replace(/^token:/, "");

  const storage: NotesStorage = {
    async upload(token, path, bytes, mime) {
      calls.push({ op: "upload", path, token });
      if (failures.upload) throw failures.upload;
      if (path.split("/")[0] !== owner(token)) throw new StorageError("Not allowed to store this file.", 403);
      if (objects.has(path)) throw new StorageError("Could not store the file.", 409); // x-upsert: false
      objects.set(path, { bytes: new Uint8Array(bytes), mime });
    },
    async download(token, path) {
      calls.push({ op: "download", path, token });
      if (failures.download) throw failures.download;
      if (path.split("/")[0] !== owner(token)) throw new StorageError("The stored file was not found.", 404);
      const o = objects.get(path);
      if (!o) throw new StorageError("The stored file was not found.", 404);
      return new Uint8Array(o.bytes);
    },
  };
  return { storage, objects, calls, failures };
}
