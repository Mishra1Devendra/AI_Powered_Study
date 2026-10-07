import type { createInMemoryNotesRepository } from "../../notes/testing/memory.js";
import type { ChunkRow, DocumentInfo, KnowledgeRepository, TopicMatch } from "../repository.js";

type NotesStore = ReturnType<typeof createInMemoryNotesRepository>;

const startsWord = (text: string, stem: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text.toLowerCase());
const stemOf = (w: string) => (w.length > 5 ? w.slice(0, 5) : w).toLowerCase();

/**
 * In-memory KnowledgeRepository for unit tests, built on the in-memory notes store. Like the real one, every
 * lookup is scoped by the verified user id and only READY, non-deleted documents are searchable, so ownership
 * logic is exercised without a database. Real SQL and Row Level Security are covered by the live integration tests.
 */
export function createInMemoryKnowledgeRepository(store: NotesStore): KnowledgeRepository & { calls: { search: number; getByRefs: number } } {
  const calls = { search: 0, getByRefs: 0 };
  const searchable = (userId: string) => [...store.docs.values()].filter((d) => d.userId === userId && !d.deletedAt && d.note.status === "ready");
  const rowOf = (d: ReturnType<typeof searchable>[number], c: (typeof d.chunks)[number], rank = 0): ChunkRow => ({
    documentId: d.note.id,
    documentTitle: d.note.title,
    chunkIndex: c.index,
    content: c.content,
    page: c.page,
    heading: c.heading,
    rank,
  });
  const info = (d: { note: { id: string; title: string; status: DocumentInfo["status"]; chunkCount: number } }): DocumentInfo => ({ id: d.note.id, title: d.note.title, status: d.note.status, chunkCount: d.note.chunkCount });

  return {
    calls,
    async search(userId, { words, documentIds, limit }) {
      calls.search++;
      const rows: ChunkRow[] = [];
      for (const d of searchable(userId)) {
        if (documentIds && !documentIds.includes(d.note.id)) continue;
        for (const c of d.chunks) {
          const rank = words.filter((w) => startsWord(c.content, stemOf(w))).length;
          if (rank > 0) rows.push(rowOf(d, c, rank));
        }
      }
      return rows.sort((a, b) => b.rank - a.rank || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex).slice(0, limit);
    },
    async getByRefs(userId, refs) {
      calls.getByRefs++;
      const rows: ChunkRow[] = [];
      for (const d of searchable(userId)) for (const c of d.chunks) if (refs.some((r) => r.documentId === d.note.id && r.chunkIndex === c.index)) rows.push(rowOf(d, c));
      return rows;
    },
    async documentInfo(userId, documentId) {
      const d = store.docs.get(documentId);
      return d && d.userId === userId && !d.deletedAt ? info(d) : null;
    },
    async readyDocuments(userId, limit) {
      return searchable(userId)
        .filter((d) => d.note.chunkCount > 0)
        .sort((a, b) => b.note.lastActivityAt.localeCompare(a.note.lastActivityAt))
        .slice(0, limit)
        .map(info);
    },
    async topicMatches(userId, topics): Promise<TopicMatch[]> {
      const out: TopicMatch[] = [];
      for (const topic of new Set(topics.map((t) => t.trim()).filter(Boolean))) {
        const stems = topic.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stemOf);
        const hit = searchable(userId).flatMap((d) => d.chunks.filter((c) => stems.every((s) => startsWord(c.content, s))).map((c) => ({ d, c }))).at(0);
        if (stems.length > 0 && hit) out.push({ topic, documentId: hit.d.note.id, documentTitle: hit.d.note.title, chunkIndex: hit.c.index, page: hit.c.page, heading: hit.c.heading });
      }
      return out;
    },
  };
}
