import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";

/** A passage straight from the database. */
export interface ChunkRow {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  page: number | null;
  heading: string | null;
  /** Full-text rank (higher = better). 0 for lookups that are not searches. */
  rank: number;
}

export interface DocumentInfo {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  chunkCount: number;
}

export interface TopicMatch {
  topic: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  page: number | null;
  heading: string | null;
}

/**
 * Read access to the student's indexed study material. Every method takes the verified user id, filters on it,
 * and runs through Row Level Security: another student's chunks can never be returned, whatever ids are passed.
 * Only READY, non-deleted documents are searchable.
 */
export interface KnowledgeRepository {
  /** Full-text search over the student's ready documents (all of them, or only `documentIds`). */
  search(userId: string, args: { words: string[]; documentIds: string[] | null; limit: number }): Promise<ChunkRow[]>;
  /** Specific passages by (document, chunk) - for follow-up questions and viva evaluation. */
  getByRefs(userId: string, refs: ReadonlyArray<{ documentId: string; chunkIndex: number }>): Promise<ChunkRow[]>;
  /** The student's own document (any status), or null. */
  documentInfo(userId: string, documentId: string): Promise<DocumentInfo | null>;
  /** The student's ready documents, most recently used first. */
  readyDocuments(userId: string, limit: number): Promise<DocumentInfo[]>;
  /** For each topic, the best passage whose text contains ALL the topic's words (only topics that have one). */
  topicMatches(userId: string, topics: readonly string[]): Promise<TopicMatch[]>;
}

type Raw = { document_id: string; title: string; chunk_index: number; content: string; metadata: unknown; rank?: number | string };
const meta = (m: unknown): { page?: number | null; heading?: string | null } => (m && typeof m === "object" ? (m as { page?: number | null; heading?: string | null }) : {});
const toRow = (r: Raw): ChunkRow => ({
  documentId: r.document_id,
  documentTitle: r.title,
  chunkIndex: r.chunk_index,
  content: r.content,
  page: meta(r.metadata).page ?? null,
  heading: meta(r.metadata).heading ?? null,
  rank: Number(r.rank ?? 0),
});

const uuidList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export function createKnowledgeRepository(db: Database): KnowledgeRepository {
  return {
    async search(userId, { words, documentIds, limit }) {
      // Words are reduced to letters/digits, so the OR-query can never be malformed (no operators get through).
      const query = words
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean)
        .join(" | ");
      if (!query || (documentIds && documentIds.length === 0)) return [];
      const scope = documentIds ? sql`and c.document_id in (${uuidList(documentIds)})` : sql``;
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<Raw>(sql`
          select c.document_id, d.title, c.chunk_index, c.content, c.metadata, ts_rank_cd(c.search_tsv, q.q) as rank
          from public.document_chunks c
          join public.documents d on d.id = c.document_id and d.user_id = c.user_id
          cross join (select to_tsquery('english', ${query}) as q) q
          where c.user_id = ${userId} and d.user_id = ${userId}
            and d.deleted_at is null and d.processing_status = 'ready'
            ${scope}
            and c.search_tsv @@ q.q
          order by rank desc, c.document_id, c.chunk_index
          limit ${limit}`),
      );
      return rows.map(toRow);
    },

    async getByRefs(userId, refs) {
      if (refs.length === 0) return [];
      const pairs = sql.join(
        refs.map((r) => sql`(${r.documentId}::uuid, ${Math.trunc(r.chunkIndex)}::int)`),
        sql`, `,
      );
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<Raw>(sql`
          select c.document_id, d.title, c.chunk_index, c.content, c.metadata
          from public.document_chunks c
          join public.documents d on d.id = c.document_id and d.user_id = c.user_id
          where c.user_id = ${userId} and d.user_id = ${userId}
            and d.deleted_at is null and d.processing_status = 'ready'
            and (c.document_id, c.chunk_index) in (${pairs})
          order by c.document_id, c.chunk_index`),
      );
      return rows.map(toRow);
    },

    async documentInfo(userId, documentId) {
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ id: string; title: string; processing_status: DocumentInfo["status"]; chunk_count: number }>(sql`
          select id, title, processing_status, chunk_count from public.documents
          where id = ${documentId}::uuid and user_id = ${userId} and deleted_at is null`),
      );
      const r = rows[0];
      return r ? { id: r.id, title: r.title, status: r.processing_status, chunkCount: r.chunk_count } : null;
    },

    async readyDocuments(userId, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ id: string; title: string; chunk_count: number }>(sql`
          select id, title, chunk_count from public.documents
          where user_id = ${userId} and deleted_at is null and processing_status = 'ready' and chunk_count > 0
          order by last_activity_at desc, id
          limit ${limit}`),
      );
      return rows.map((r) => ({ id: r.id, title: r.title, status: "ready" as const, chunkCount: r.chunk_count }));
    },

    async topicMatches(userId, topics) {
      const clean = [...new Set(topics.map((t) => t.trim()).filter(Boolean))];
      if (clean.length === 0) return [];
      const values = sql.join(
        clean.map((t) => sql`(${t})`),
        sql`, `,
      );
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ topic: string; document_id: string; title: string; chunk_index: number; metadata: unknown }>(sql`
          select t.topic, m.document_id, m.title, m.chunk_index, m.metadata
          from (values ${values}) as t(topic)
          cross join lateral (
            select c.document_id, d.title, c.chunk_index, c.metadata
            from public.document_chunks c
            join public.documents d on d.id = c.document_id and d.user_id = c.user_id
            where c.user_id = ${userId} and d.user_id = ${userId}
              and d.deleted_at is null and d.processing_status = 'ready'
              and c.search_tsv @@ plainto_tsquery('english', t.topic)
            order by ts_rank_cd(c.search_tsv, plainto_tsquery('english', t.topic)) desc, d.last_activity_at desc, c.chunk_index
            limit 1
          ) m`),
      );
      return rows.map((r) => ({
        topic: r.topic,
        documentId: r.document_id,
        documentTitle: r.title,
        chunkIndex: r.chunk_index,
        page: meta(r.metadata).page ?? null,
        heading: meta(r.metadata).heading ?? null,
      }));
    },
  };
}
