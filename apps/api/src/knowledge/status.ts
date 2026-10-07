import type { IndexStatus, Note } from "@copilot/shared";

/**
 * How ready a document is for AI questions, from its real processing state. The text is stored in the same step that
 * marks the document ready, and the full-text index is part of that table, so "ready" means "searchable" - there is no
 * separate half-way state to invent, and no fake percentage.
 */
export function toIndexStatus(note: Pick<Note, "id" | "status" | "chunkCount" | "error">): IndexStatus {
  const base = { documentId: note.id, status: note.status, chunkCount: note.chunkCount, method: "keyword", embeddings: false } as const;
  if (note.status === "ready" && note.chunkCount > 0) {
    return { ...base, state: "indexed", message: "Indexed - AI can now answer questions from this document.", error: null };
  }
  if (note.status === "failed") {
    return { ...base, state: "failed", message: "We couldn't prepare this document.", error: note.error };
  }
  return {
    ...base,
    state: "preparing",
    message: note.status === "uploading" ? "Uploading your file..." : "Preparing your study material: extracting text and creating the knowledge index...",
    error: null,
  };
}
