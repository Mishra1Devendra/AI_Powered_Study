import { KNOWLEDGE_LIMITS } from "@copilot/shared";
import { ConflictError, NotFoundError } from "../errors.js";
import { evenIndexes, extractKeywords } from "../notes/retrieval.js";
import type { ChunkRef, GroundingContext, RetrievalResult, RetrievedChunk, SourceReference } from "./types.js";
import type { ChunkRow, DocumentInfo, KnowledgeRepository, TopicMatch } from "./repository.js";

/** Candidates fetched from the database before they are re-ranked and cut down to the few best. */
const CANDIDATES = 12;
/** Documents considered when no document is named (the most recently used ones). */
const MAX_DOCUMENTS = 20;

export interface RetrieveOptions {
  /** The student's question (or topic). */
  query: string;
  /** Search only this document. Ownership is verified here - an id from the client is never trusted. */
  documentId?: string | null;
  /** Search only these documents (each verified). Ignored when `documentId` is given. */
  documentIds?: readonly string[] | null;
  /** How many passages to return (1-8, default 5). */
  limit?: number;
  /** Cap on the total characters of the passages. */
  budgetChars?: number;
  /** Override the share of search words a passage must contain (0 = any match counts). */
  minCoverage?: number;
}

const PUNCT = /[^\p{L}\p{N}]/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Share of the search words that appear (as the start of a word) in the text. Word starts, so "engine" matches "engines". */
export function keywordCoverage(keywords: readonly string[], text: string): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const kw of keywords) {
    const stem = kw.length > 5 ? kw.slice(0, 5) : kw;
    if (new RegExp(`(^|${PUNCT.source})${escapeRe(stem)}`, "u").test(lower)) hit++;
  }
  return hit / keywords.length;
}

const enough = (coverage: number, keywordCount: number, minCoverage: number) => coverage > 0 && coverage * keywordCount + 1e-9 >= Math.ceil(minCoverage * keywordCount - 1e-9);

/**
 * Knowledge grounding. ONE place that turns a question into the student's own passages:
 *   question -> search words -> full-text search of the student's ready documents (scoped by user, RLS-checked)
 *   -> re-rank by how many of the words each passage really contains -> keep the few relevant ones within a budget.
 * It never calls an AI model and never reads another student's data. If a passage is not relevant it is not returned,
 * so an unrelated question yields an empty result instead of a "best guess".
 *
 * Vector search: not used. PostgreSQL's `vector` extension is available but no embedding model is installed locally, and
 * this version deliberately does not download one. `retrieveRelevantChunks` is the single seam where a vector
 * search could be added later without touching the Tutor, Quiz, Viva, Notes or Recommendations code.
 */
export function createKnowledgeService({ repo }: { repo: KnowledgeRepository }) {
  /** The student's own READY document, or a clear error. Someone else's document is indistinguishable from a missing one. */
  async function requireReadyDocument(userId: string, documentId: string): Promise<DocumentInfo> {
    const info = await repo.documentInfo(userId, documentId);
    if (!info) throw new NotFoundError("Document not found.");
    if (info.status !== "ready") throw new ConflictError("This document isn't ready yet.");
    return info;
  }

  async function resolveScope(userId: string, opts: Pick<RetrieveOptions, "documentId" | "documentIds">): Promise<string[] | null> {
    const ids = opts.documentId ? [opts.documentId] : opts.documentIds ? [...new Set(opts.documentIds)] : null;
    if (!ids) return null;
    await Promise.all(ids.map((id) => requireReadyDocument(userId, id)));
    return ids;
  }

  function rank(rows: ChunkRow[], keywords: string[], minCoverage: number): RetrievedChunk[] {
    const maxRank = Math.max(0, ...rows.map((r) => r.rank));
    return rows
      .map((r) => {
        const coverage = keywordCoverage(keywords, `${r.heading ?? ""}\n${r.content}`);
        const score = 0.7 * coverage + 0.3 * (maxRank > 0 ? r.rank / maxRank : 0);
        return { documentId: r.documentId, documentTitle: r.documentTitle, chunkIndex: r.chunkIndex, content: r.content, page: r.page, heading: r.heading, coverage, score };
      })
      .filter((c) => enough(c.coverage, keywords.length, minCoverage))
      .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex);
  }

  /** Cuts the best passages down to `limit` and the character budget (always keeps at least one). */
  function withinBudget(chunks: RetrievedChunk[], limit: number, budget: number): RetrievedChunk[] {
    const out: RetrievedChunk[] = [];
    let used = 0;
    for (const c of chunks) {
      if (out.length >= limit) break;
      if (out.length > 0 && used + c.content.length > budget) continue;
      out.push(c);
      used += c.content.length;
    }
    return out;
  }

  async function retrieveRelevantChunks(userId: string, opts: RetrieveOptions): Promise<RetrievalResult> {
    const query = opts.query.trim();
    const keywords = extractKeywords(query);
    const scope = await resolveScope(userId, opts);
    if (keywords.length === 0) return { query, keywords, chunks: [], relevant: false, method: "none" };
    const limit = Math.min(Math.max(opts.limit ?? KNOWLEDGE_LIMITS.defaultChunks, 1), KNOWLEDGE_LIMITS.maxChunks);
    const rows = await repo.search(userId, { words: keywords, documentIds: scope, limit: CANDIDATES });
    const minCoverage = opts.minCoverage ?? (scope ? KNOWLEDGE_LIMITS.scopedMinKeywordCoverage : KNOWLEDGE_LIMITS.minKeywordCoverage);
    const ranked = rank(rows, keywords, minCoverage);
    const chunks = withinBudget(ranked, limit, opts.budgetChars ?? KNOWLEDGE_LIMITS.contextBudgetChars);
    return { query, keywords, chunks, relevant: chunks.length > 0, method: "fulltext" };
  }

  /** Passages -> labelled prompt sources ([S1], [S2]...) and the references the UI shows. Document order reads best. */
  function buildGrounding(chunks: readonly RetrievedChunk[]): GroundingContext {
    const firstSeen = new Map<string, number>();
    chunks.forEach((c) => firstSeen.has(c.documentId) || firstSeen.set(c.documentId, firstSeen.size));
    const ordered = [...chunks].sort((a, b) => firstSeen.get(a.documentId)! - firstSeen.get(b.documentId)! || a.chunkIndex - b.chunkIndex);
    return {
      sources: ordered.map((c, i) => ({ key: `S${i + 1}`, page: c.page, heading: c.heading, content: c.content, documentTitle: c.documentTitle })),
      refs: ordered.map((c, i): SourceReference => ({ key: `S${i + 1}`, chunkIndex: c.chunkIndex, page: c.page, heading: c.heading, documentId: c.documentId, documentTitle: c.documentTitle })),
    };
  }

  /** The exact passages a previous answer / viva question was based on (only if still the student's and ready). */
  async function chunksForRefs(userId: string, refs: readonly ChunkRef[]): Promise<RetrievedChunk[]> {
    const rows = await repo.getByRefs(userId, refs);
    return rows.map((r) => ({ documentId: r.documentId, documentTitle: r.documentTitle, chunkIndex: r.chunkIndex, content: r.content, page: r.page, heading: r.heading, coverage: 1, score: 1 }));
  }

  /**
   * ONE passage to base a viva question on. With a topic (or subject) the best matching passage the viva has not used yet;
   * with nothing to match, passages spread evenly over the chosen documents. Returns null when the material has nothing
   * relevant. `exclude` = passages earlier questions already used.
   */
  async function passageForQuestion(
    userId: string,
    args: { documentId?: string | null; query: string | null; number: number; exclude: readonly ChunkRef[]; requireMatch: boolean },
  ): Promise<RetrievedChunk | null> {
    const used = new Set(args.exclude.map((r) => `${r.documentId}:${r.chunkIndex}`));
    const fresh = (c: { documentId: string; chunkIndex: number }) => !used.has(`${c.documentId}:${c.chunkIndex}`);
    const scope = args.documentId ? { documentId: args.documentId } : {};
    if (args.documentId) await requireReadyDocument(userId, args.documentId);

    if (args.query && extractKeywords(args.query).length > 0) {
      const found = await retrieveRelevantChunks(userId, { query: args.query, ...scope, limit: KNOWLEDGE_LIMITS.maxChunks, minCoverage: args.requireMatch ? KNOWLEDGE_LIMITS.minKeywordCoverage : 0 });
      if (found.chunks.length > 0) {
        const pool = found.chunks.filter(fresh);
        const choices = pool.length > 0 ? pool : found.chunks;
        return choices[(args.number - 1) % choices.length] ?? null;
      }
      if (args.requireMatch) return null;
    }
    // Nothing to search for (or the subject is not mentioned in the notes): walk through the documents evenly.
    const docs = args.documentId ? [await requireReadyDocument(userId, args.documentId)] : await repo.readyDocuments(userId, MAX_DOCUMENTS);
    const usable = docs.filter((d) => d.chunkCount > 0);
    if (usable.length === 0) return null;
    const doc = usable[(args.number - 1) % usable.length]!;
    const round = Math.floor((args.number - 1) / usable.length);
    const spots = evenIndexes(doc.chunkCount, Math.min(doc.chunkCount, 8));
    const wanted: number[] = [];
    for (let i = 0; i < spots.length; i++) wanted.push(spots[(round + i) % spots.length]!);
    const rows = await repo.getByRefs(userId, wanted.map((chunkIndex) => ({ documentId: doc.id, chunkIndex })));
    const byIndex = new Map(rows.map((r) => [r.chunkIndex, r]));
    const pick = wanted.map((i) => byIndex.get(i)).find((r) => r && fresh(r)) ?? wanted.map((i) => byIndex.get(i)).find(Boolean);
    return pick ? { documentId: pick.documentId, documentTitle: pick.documentTitle, chunkIndex: pick.chunkIndex, content: pick.content, page: pick.page, heading: pick.heading, coverage: 1, score: 1 } : null;
  }

  return {
    retrieveRelevantChunks,
    buildGrounding,
    chunksForRefs,
    passageForQuestion,
    requireReadyDocument,
    /** The student's ready documents, most recently used first (for "My notes" sources). */
    readyDocuments: (userId: string, limit = MAX_DOCUMENTS): Promise<DocumentInfo[]> => repo.readyDocuments(userId, limit),
    /** For recommendations: topics that really appear in a document, with the passage that proves it. */
    topicMatches: (userId: string, topics: readonly string[]): Promise<TopicMatch[]> => repo.topicMatches(userId, topics),
  };
}

export type KnowledgeService = ReturnType<typeof createKnowledgeService>;
