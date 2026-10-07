import { z } from "zod";

/** Limits enforced by the API and mirrored in the UI for early feedback. */
export const NOTE_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPastedChars: 200_000,
  maxPages: 300,
  maxChunks: 1_500,
  titleMaxChars: 200,
  questionMaxChars: 2_000,
} as const;

/** File types supported today. DOCX / images can be added later by extending `extract.ts`. */
export const NOTE_FILE_TYPES = ["pdf", "txt", "md"] as const;
export const noteFileTypeSchema = z.enum(NOTE_FILE_TYPES);
export type NoteFileType = z.infer<typeof noteFileTypeSchema>;

export const NOTE_ACCEPT_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown"] as const;

export const noteStatusSchema = z.enum(["uploading", "processing", "ready", "failed"]);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

const isoTime = z.string().datetime({ offset: true });

export const noteSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  originalFilename: z.string(),
  fileType: noteFileTypeSchema,
  source: z.enum(["upload", "paste"]),
  fileSize: z.number().int().nonnegative(),
  status: noteStatusSchema,
  /** Safe, student-readable reason when status is "failed". */
  error: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  chunkCount: z.number().int().nonnegative(),
  /** Phase 11: true when the text is stored and searchable, so the AI can answer from this document. */
  indexed: z.boolean().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
  lastActivityAt: isoTime,
});
export type Note = z.infer<typeof noteSchema>;

export const noteListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: noteFileTypeSchema.optional(),
  status: noteStatusSchema.optional(),
  sort: z.enum(["recent", "oldest", "name", "activity"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;

export const noteIdParamSchema = z.object({ id: z.string().uuid("Invalid note id") });

export const pasteNoteInputSchema = z.object({
  title: z.string().trim().max(NOTE_LIMITS.titleMaxChars).optional(),
  text: z
    .string()
    .trim()
    .min(1, "Paste some text first")
    .max(NOTE_LIMITS.maxPastedChars, `Pasted text can be at most ${NOTE_LIMITS.maxPastedChars.toLocaleString("en-US")} characters`),
});
export type PasteNoteInput = z.infer<typeof pasteNoteInputSchema>;

export const noteChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  page: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  heading: z.string().nullable(),
  content: z.string(),
});
export type NoteChunk = z.infer<typeof noteChunkSchema>;

export const outlineItemSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  heading: z.string(),
  page: z.number().int().nullable(),
});

export const noteListResponseSchema = z.object({ notes: z.array(noteSchema) });
export const noteResponseSchema = z.object({ note: noteSchema });
export const noteDetailResponseSchema = z.object({ note: noteSchema, outline: z.array(outlineItemSchema) });

export const noteContentQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const noteContentResponseSchema = z.object({
  chunks: z.array(noteChunkSchema),
  /** Index to pass as `cursor` for the next page, or null at the end. */
  nextCursor: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
});

/* ------------------------------ AI study assistant ------------------------------ */

export const ASSISTANT_ACTIONS = [
  "explain",
  "summarize",
  "key_concepts",
  "definitions",
  "formulas",
  "flashcards",
  "quiz",
  "important_topics",
  "ask",
] as const;
export const assistantActionSchema = z.enum(ASSISTANT_ACTIONS);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

/** UI metadata. The behaviour itself lives in the API prompt layer. */
export const ASSISTANT_ACTION_INFO: Record<AssistantAction, { label: string; hint: string; defaultMessage: string }> = {
  explain: { label: "Explain", hint: "Explain the material simply", defaultMessage: "Explain this material to me simply." },
  summarize: { label: "Summarize", hint: "A concise summary", defaultMessage: "Summarize this document." },
  key_concepts: { label: "Key concepts", hint: "The ideas that matter", defaultMessage: "What are the key concepts in this document?" },
  definitions: { label: "Definitions", hint: "Important terms", defaultMessage: "List the important terms and their definitions." },
  formulas: { label: "Formulas", hint: "Formulas and meanings", defaultMessage: "Identify the formulas in this document and explain what they mean." },
  flashcards: { label: "Flashcards", hint: "Study cards", defaultMessage: "Create flashcards from this document." },
  quiz: { label: "Quiz me", hint: "Questions from your notes", defaultMessage: "Quiz me on this document." },
  important_topics: { label: "Important topics", hint: "Likely exam topics", defaultMessage: "Which topics in this document look most important to study?" },
  ask: { label: "Ask a question", hint: "Ask anything about it", defaultMessage: "" },
};

export const assistantInputSchema = z
  .object({
    action: assistantActionSchema,
    question: z.string().trim().max(NOTE_LIMITS.questionMaxChars, `Questions can be at most ${NOTE_LIMITS.questionMaxChars} characters`).optional(),
  })
  .refine((v) => v.action !== "ask" || Boolean(v.question), { message: "Type your question first", path: ["question"] });
export type AssistantInput = z.infer<typeof assistantInputSchema>;

/**
 * A piece of the document the AI was GIVEN for an answer. Built by the server from real chunk
 * metadata - never generated by the model - so page numbers and headings cannot be invented.
 * `key` ("S1", "S2"...) is how the model refers to it in its text.
 */
export const sourceRefSchema = z.object({
  key: z.string().regex(/^S\d{1,2}$/),
  chunkIndex: z.number().int().nonnegative(),
  page: z.number().int().nullable(),
  heading: z.string().nullable(),
  /** Phase 11: which document the passage is from (set when more than one document could be searched). */
  documentId: z.string().uuid().optional(),
  documentTitle: z.string().optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;
