import type { GroundingOutcome, GroundingPreference, SourceRef } from "@copilot/shared";
import { AppError } from "../errors.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { SourceReference } from "../knowledge/types.js";
import { extractKeywords } from "../notes/retrieval.js";
import type { PromptSource } from "../services/ai/notes/prompt.js";

/**
 * What the Tutor does with the student's own material for ONE question:
 *   none      - nothing to add: an ordinary tutor answer (no documents matched, or nothing was searched).
 *   grounded  - relevant passages were found: the answer uses them and cites them.
 *   not_found - the student asked about their material (named a document, or said "my notes") and it does not
 *               contain the topic. The server answers this itself; no AI call is made, nothing is cited.
 *   general   - the student pressed "Explain generally": answer from general knowledge, clearly labelled.
 */
export type TutorGrounding =
  | { kind: "none" }
  | { kind: "grounded"; sources: Array<PromptSource & { documentTitle: string }>; refs: SourceReference[] }
  | { kind: "not_found" }
  | { kind: "general" };

/** The student is clearly talking about their own uploaded material ("in my notes", "my pdf", "the document"...). */
const ASKS_ABOUT_NOTES = /\b(?:my|the|our|these|this)\s+(?:uploaded\s+)?(?:notes?|documents?|docs?|pdfs?|files?|uploads?|material|slides?|chapters?|textbook|handouts?)\b|\b(?:uploaded|study material)\b/i;
export const asksAboutNotes = (message: string) => ASKS_ABOUT_NOTES.test(message);

/** A follow-up such as "explain that again" has too few distinctive words to search with. */
const FOLLOW_UP_MAX_KEYWORDS = 2;

export const outcomeOf = (g: TutorGrounding): GroundingOutcome | undefined => (g.kind === "none" ? undefined : g.kind === "grounded" ? "grounded" : g.kind);

export interface GroundTurnInput {
  knowledge: KnowledgeService;
  userId: string;
  message: string;
  /** A document the student chose to ask about. Already verified by the caller; verified again by retrieval. */
  documentId?: string | undefined;
  preference: GroundingPreference;
  /** The sources of the previous grounded answer, for follow-up questions. */
  previousRefs: readonly SourceRef[];
  onError?: ((err: unknown) => void) | undefined;
}

export async function groundTutorTurn(input: GroundTurnInput): Promise<TutorGrounding> {
  const { knowledge, userId, message, documentId, preference, previousRefs, onError } = input;
  if (preference === "general") return { kind: "general" };
  const scoped = Boolean(documentId);
  const explicit = scoped || asksAboutNotes(message);

  let found;
  try {
    found = await knowledge.retrieveRelevantChunks(userId, { query: message, ...(documentId ? { documentId } : {}) });
  } catch (err) {
    // A search problem must not stop an ordinary tutor answer. A document the student named, though, must be real.
    if (scoped || err instanceof AppError) throw err;
    onError?.(err);
    return { kind: "none" };
  }

  let chunks = found.chunks;
  if (chunks.length === 0 && extractKeywords(message).length <= FOLLOW_UP_MAX_KEYWORDS) {
    // "Explain that again": keep using the passages the last answer was based on.
    const refs = previousRefs.flatMap((r) => (r.documentId ? [{ documentId: r.documentId, chunkIndex: r.chunkIndex }] : []));
    if (refs.length > 0 && (!documentId || refs.every((r) => r.documentId === documentId))) {
      try {
        chunks = await knowledge.chunksForRefs(userId, refs.slice(0, 4));
      } catch (err) {
        onError?.(err);
      }
    }
  }

  if (chunks.length > 0) {
    const { sources, refs } = knowledge.buildGrounding(chunks);
    return { kind: "grounded", sources, refs };
  }
  return explicit ? { kind: "not_found" } : { kind: "none" };
}
