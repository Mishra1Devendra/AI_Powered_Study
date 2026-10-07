import { z } from "zod";

/**
 * KNOWLEDGE GROUNDING (Phase 11) - shared vocabulary.
 *
 * The AI answers from the student's own study material in three outcomes:
 *   grounded  - relevant passages were found and given to the AI; the answer cites them.
 *   not_found - the student asked about their material but nothing relevant is in it; no AI call was made.
 *   general   - the answer is general knowledge (nothing relevant in the notes, or the student asked for it).
 * Retrieval today is PostgreSQL full-text search (keyword). It needs no embedding model and costs nothing.
 */
export const GROUNDING_OUTCOMES = ["grounded", "not_found", "general"] as const;
export const groundingOutcomeSchema = z.enum(GROUNDING_OUTCOMES);
export type GroundingOutcome = z.infer<typeof groundingOutcomeSchema>;

/** What the student can ask the tutor to do with their material. `general` = skip the notes ("Explain Generally"). */
export const groundingPreferenceSchema = z.enum(["auto", "general"]);
export type GroundingPreference = z.infer<typeof groundingPreferenceSchema>;

export const KNOWLEDGE_LIMITS = {
  /** Passages sent to the AI for one question. */
  defaultChunks: 5,
  maxChunks: 8,
  /** About 1,500 tokens of passages: leaves room for instructions, history and the answer. */
  contextBudgetChars: 6_000,
  /** A question must match at least this share of its search words in a passage to count as "in your notes". */
  minKeywordCoverage: 0.6,
  /**
   * When the student CHOSE one document, they already told us where to look, so a question only has to share about a third of its
   * words with it ("Explain photosynthesis simply" is about a photosynthesis note even though "simply" is not in it).
   * The model is still instructed to say when the passages do not answer the question.
   */
  scopedMinKeywordCoverage: 0.3,
} as const;

/** Shown when the student asked about their material and it does not contain the topic. */
export const NOT_IN_NOTES_MESSAGE = "I couldn't find this topic in your uploaded material. I can still explain it using general knowledge.";
export const NO_RELEVANT_MATERIAL_MESSAGE = "I couldn't find relevant information in this material.";
export const SCANNED_PDF_MESSAGE = "This document appears to contain scanned/image-only pages. Text-based AI grounding is not available for this document yet.";

export const INDEX_STATES = ["preparing", "indexed", "failed"] as const;
export const indexStateSchema = z.enum(INDEX_STATES);
export type IndexState = z.infer<typeof indexStateSchema>;

/** How a document is searched. Always "keyword" today: no embedding model is installed, so none is used. */
export const indexStatusSchema = z.object({
  documentId: z.string().uuid(),
  state: indexStateSchema,
  /** The document's processing status (uploading / processing / ready / failed). */
  status: z.enum(["uploading", "processing", "ready", "failed"]),
  chunkCount: z.number().int().nonnegative(),
  method: z.literal("keyword"),
  /** Always false in this version: no vector embeddings are stored. */
  embeddings: z.literal(false),
  message: z.string(),
  error: z.string().nullable(),
});
export type IndexStatus = z.infer<typeof indexStatusSchema>;

/** The document the student may be asked about / a source for a quiz or viva. */
export const SOURCE_MODES = ["general", "notes", "document"] as const;
export const sourceModeSchema = z.enum(SOURCE_MODES);
export type SourceMode = z.infer<typeof sourceModeSchema>;
export const SOURCE_MODE_LABEL: Record<SourceMode, string> = { general: "General knowledge", notes: "My notes", document: "Specific document" };
