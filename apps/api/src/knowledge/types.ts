import type { GroundingOutcome, SourceRef } from "@copilot/shared";
import type { PromptSource } from "../services/ai/notes/prompt.js";

/** One passage of one of the student's documents, as found by retrieval. Built only from stored chunk data. */
export interface RetrievedChunk {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  /** Real metadata from the document, or null when it has none. Never guessed. */
  page: number | null;
  heading: string | null;
  /** Share of the question's search words found in this passage (0-1). */
  coverage: number;
  /** Combined ranking score (0-1): keyword coverage plus the database's full-text rank. */
  score: number;
}

/** A passage the AI was given, with the document it is from: what the UI shows as a source. */
export type SourceReference = SourceRef & { documentId: string; documentTitle: string };

export interface RetrievalResult {
  query: string;
  /** The search words taken from the query. */
  keywords: string[];
  /** The passages judged relevant, best first. Empty = nothing relevant in the student's material. */
  chunks: RetrievedChunk[];
  relevant: boolean;
  /** How the passages were found. "fulltext" = PostgreSQL full-text search; "none" = nothing was searched. */
  method: "fulltext" | "none";
}

/** What goes into a prompt: labelled passages ([S1], [S2]...) and the matching references for the UI. */
export interface GroundingContext {
  sources: Array<PromptSource & { documentTitle: string }>;
  refs: SourceReference[];
}

/** The outcome of one grounded answer. */
export interface GroundedAnswer {
  content: string;
  outcome: GroundingOutcome;
  sources: SourceReference[];
  model: string;
  isMock: boolean;
}

export interface ChunkRef {
  documentId: string;
  chunkIndex: number;
}
