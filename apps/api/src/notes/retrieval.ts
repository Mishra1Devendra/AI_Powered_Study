import type { AssistantAction, SourceRef } from "@copilot/shared";
import type { PromptSource } from "../services/ai/notes/prompt.js";
import type { ChunkHit, NotesRepository } from "./repository.js";

/**
 * Context pipeline for the notes assistant:
 *   question + action -> pick relevant chunks (full-text search / even coverage) -> labelled sources.
 *
 * This is deliberately simple. Each step works on plain chunk data, so semantic / vector search can
 * later replace `searchChunks` (embeddings stored per chunk) without touching the prompt, routes or UI.
 */

/** About 2,500 tokens of passages: leaves room for instructions, history and the answer in an 8k context. */
export const CONTEXT_BUDGET_CHARS = 9_000;
const MAX_SOURCES = 8;
const SEARCH_HITS = 6;

const STOPWORDS = new Set(
  "the and for are but not you your with that this from have has had was were what when where which who whom why how can could would should will shall about into than then them they their there these those been being does did done its it's our out one two say says said tell please explain describe give show list make find any all some more most such very also just only like use used using simply briefly brief shortly detail details detailed example examples easily quickly clearly understand help concept topic basically".split(
    " ",
  ),
);

/** Search words from a question: lowercase, 3+ letters/digits, no stopwords, unique, capped. */
export function extractKeywords(text: string, max = 12): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (!STOPWORDS.has(raw)) seen.add(raw);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Words that tend to sit near the thing a structured action is looking for. */
const ACTION_HINT_WORDS: Partial<Record<AssistantAction, string[]>> = {
  definitions: ["defined", "definition", "means", "refers", "called", "known", "term"],
  formulas: ["formula", "equation", "equals", "calculate", "derive", "where", "value"],
};

/** `count` indexes spread evenly over [0, total-1], always including the first and last. */
export function evenIndexes(total: number, count: number): number[] {
  if (total <= 0 || count <= 0) return [];
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [0];
  return [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1))))];
}

export interface SelectedContext {
  sources: PromptSource[];
  refs: SourceRef[];
  coverage: { used: number; total: number };
}

export interface SelectContextArgs {
  repo: NotesRepository;
  userId: string;
  documentId: string;
  chunkCount: number;
  action: AssistantAction;
  /** The student's question or request text. */
  query: string;
  /** Chunk indexes the previous answer was grounded on (helps follow-ups like "explain the second step"). */
  previousChunkIndexes: number[];
  budgetChars?: number;
}

/** Orders items so that dropping from the END thins them evenly: first, last, middle, quarters... */
export function bisectOrder<T>(items: readonly T[]): T[] {
  if (items.length <= 2) return [...items];
  const out: T[] = [items[0]!, items[items.length - 1]!];
  const queue: Array<[number, number]> = [[0, items.length - 1]];
  while (queue.length) {
    const [l, r] = queue.shift()!;
    if (r - l < 2) continue;
    const m = (l + r) >> 1;
    out.push(items[m]!);
    queue.push([l, m], [m, r]);
  }
  return out;
}

export async function selectContext(args: SelectContextArgs): Promise<SelectedContext> {
  const { repo, userId, documentId, chunkCount, action, query, previousChunkIndexes } = args;
  const budget = args.budgetChars ?? CONTEXT_BUDGET_CHARS;

  // Candidates in PRIORITY order: when the budget runs out, the least important are dropped.
  const candidates: ChunkHit[] = [];
  const seen = new Set<number>();
  const add = (hits: ChunkHit[]) => {
    for (const h of hits) if (!seen.has(h.chunkIndex)) (seen.add(h.chunkIndex), candidates.push(h));
  };

  const keywords = extractKeywords(query);
  const questionDriven = action === "ask" || (action === "explain" && query.trim().length > 0 && keywords.length > 0);
  if (questionDriven) {
    add(await repo.searchChunks(userId, documentId, keywords, SEARCH_HITS)); // best matches first
    // A follow-up has few distinctive words; keep what the last answer was based on.
    if (candidates.length < 3 || keywords.length <= 2) {
      add(await repo.getChunks(userId, documentId, previousChunkIndexes.slice(0, 4)));
    }
  } else {
    const hint = ACTION_HINT_WORDS[action];
    if (hint) add(await repo.searchChunks(userId, documentId, hint, SEARCH_HITS));
  }

  // Then chunks spread across the whole document, so the AI sees its full arc (thinned evenly if too long).
  const wantSpread = questionDriven ? (candidates.length >= 3 ? 0 : 3) : MAX_SOURCES;
  if (wantSpread > 0) {
    const spread = evenIndexes(chunkCount, Math.max(wantSpread, 0)).filter((i) => !seen.has(i));
    const fetched = await repo.getChunks(userId, documentId, spread);
    add(questionDriven ? fetched : bisectOrder(fetched));
  }

  const chosen: ChunkHit[] = [];
  let used = 0;
  for (const hit of candidates) {
    if (chosen.length >= MAX_SOURCES) break;
    if (chosen.length > 0 && used + hit.content.length > budget) continue;
    chosen.push(hit);
    used += hit.content.length;
  }
  chosen.sort((a, b) => a.chunkIndex - b.chunkIndex); // document order reads best

  const sources: PromptSource[] = chosen.map((c, i) => ({ key: `S${i + 1}`, page: c.page, heading: c.heading, content: c.content }));
  const refs: SourceRef[] = chosen.map((c, i) => ({ key: `S${i + 1}`, chunkIndex: c.chunkIndex, page: c.page, heading: c.heading }));
  return { sources, refs, coverage: { used: chosen.length, total: chunkCount } };
}
