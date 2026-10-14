import { z } from "zod";

/**
 * Flashcards and mind maps. Both are written by the AI on the student's click only (ONE AI call each, never scheduled or polled),
 * from the student's own notes or from a subject/topic. Flashcards are then scheduled with spaced repetition (server-side), so the
 * client only ever says how well a card was remembered.
 */

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);

export const STUDY_TOOLS_LIMITS = {
  maxNotes: 3,
  subjectMaxChars: 100,
  topicMaxChars: 100,
  focusMaxChars: 200,
  titleMaxChars: 120,
  minCards: 5,
  maxCards: 30,
  defaultCards: 12,
  frontMaxChars: 300,
  backMaxChars: 600,
  hintMaxChars: 160,
  /** Cards handed out per study round, so one sitting stays short. */
  studyBatch: 20,
  maxCardsPerDeck: 200,
  maxDecks: 100,
  maxMindmaps: 100,
  /** Mind map shape limits (also enforced on what the AI returns). */
  maxMapDepth: 4,
  maxMapNodes: 60,
  maxChildren: 8,
  labelMaxChars: 80,
  noteMaxChars: 220,
} as const;

/* ------------------------------------- shared: where it comes from ------------------------------------- */

export const studySourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notes"),
    documentIds: z.array(uuid).min(1, "Choose at least one note").max(STUDY_TOOLS_LIMITS.maxNotes, `Choose at most ${STUDY_TOOLS_LIMITS.maxNotes} notes`),
    /** Optional: only use this part of the notes. */
    focus: text(STUDY_TOOLS_LIMITS.focusMaxChars).optional(),
  }),
  z.object({
    type: z.literal("topic"),
    subject: text(STUDY_TOOLS_LIMITS.subjectMaxChars).min(1, "Enter a subject"),
    topic: text(STUDY_TOOLS_LIMITS.topicMaxChars).optional(),
  }),
]);
export type StudySource = z.infer<typeof studySourceSchema>;

export const generationStatusSchema = z.enum(["generating", "ready", "error"]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

/* ----------------------------------------- flashcards ----------------------------------------- */

export const cardGradeSchema = z.enum(["again", "hard", "good", "easy"]);
export type CardGrade = z.infer<typeof cardGradeSchema>;

export const cardStateSchema = z.enum(["new", "learning", "review"]);
export type CardState = z.infer<typeof cardStateSchema>;

export const flashcardSchema = z.object({
  id: uuid,
  deckId: uuid,
  front: z.string(),
  back: z.string(),
  hint: z.string().nullable(),
  state: cardStateSchema,
  /** When it is next due (ISO). New cards are due now. */
  dueAt: z.string(),
  intervalDays: z.number().int().nonnegative(),
  repetitions: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  /** When each answer would bring the card back, in days (0 = within minutes). Lets the buttons say what they do. */
  nextDays: z.object({ again: z.number().int().nonnegative(), hard: z.number().int().nonnegative(), good: z.number().int().nonnegative(), easy: z.number().int().nonnegative() }),
});
export type Flashcard = z.infer<typeof flashcardSchema>;

export const deckSchema = z.object({
  id: uuid,
  title: z.string(),
  sourceType: z.enum(["notes", "topic", "manual"]),
  status: generationStatusSchema,
  /** A student-safe reason when writing the cards failed. */
  error: z.string().nullable(),
  /** True when the labelled demo AI wrote the cards (no real AI was available). */
  isMock: z.boolean(),
  cardCount: z.number().int().nonnegative(),
  dueCount: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Deck = z.infer<typeof deckSchema>;

export const generateDeckInputSchema = z
  .object({
    source: studySourceSchema,
    count: z.number().int().min(STUDY_TOOLS_LIMITS.minCards).max(STUDY_TOOLS_LIMITS.maxCards).default(STUDY_TOOLS_LIMITS.defaultCards),
    title: text(STUDY_TOOLS_LIMITS.titleMaxChars).optional(),
  })
  .strict();
export type GenerateDeckInput = z.infer<typeof generateDeckInputSchema>;

export const createDeckInputSchema = z.object({ title: text(STUDY_TOOLS_LIMITS.titleMaxChars).min(1, "Give the deck a name") }).strict();
export const renameInputSchema = z.object({ title: text(STUDY_TOOLS_LIMITS.titleMaxChars).min(1, "Give it a name") }).strict();
export type RenameInput = z.infer<typeof renameInputSchema>;

export const cardInputSchema = z
  .object({
    front: text(STUDY_TOOLS_LIMITS.frontMaxChars).min(1, "Write the question side"),
    back: text(STUDY_TOOLS_LIMITS.backMaxChars).min(1, "Write the answer side"),
    hint: text(STUDY_TOOLS_LIMITS.hintMaxChars).optional(),
  })
  .strict();
export type CardInput = z.infer<typeof cardInputSchema>;
export const updateCardInputSchema = cardInputSchema.partial().strict().refine((v) => Object.keys(v).length > 0, "Nothing to change.");
export type UpdateCardInput = z.infer<typeof updateCardInputSchema>;

export const reviewInputSchema = z.object({ grade: cardGradeSchema }).strict();
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const deckListResponseSchema = z.object({
  decks: z.array(deckSchema),
  /** Cards due now across every deck. */
  dueTotal: z.number().int().nonnegative(),
  /** Cards reviewed since local midnight UTC today. */
  reviewedToday: z.number().int().nonnegative(),
});
export type DeckListResponse = z.infer<typeof deckListResponseSchema>;

export const deckDetailResponseSchema = z.object({ deck: deckSchema, cards: z.array(flashcardSchema) });
export type DeckDetailResponse = z.infer<typeof deckDetailResponseSchema>;
export const deckResponseSchema = z.object({ deck: deckSchema });
export const cardResponseSchema = z.object({ card: flashcardSchema });
export type DeckResponse = z.infer<typeof deckResponseSchema>;

/** Cards to study now (due, then new), at most `studyBatch`. `remaining` counts what is still due after this round. */
export const studyQueueResponseSchema = z.object({ deck: deckSchema, cards: z.array(flashcardSchema), remaining: z.number().int().nonnegative() });
export type StudyQueueResponse = z.infer<typeof studyQueueResponseSchema>;

/** After a review: the updated card and, for the buttons, when each answer would bring it back. */
export const reviewResponseSchema = z.object({ card: flashcardSchema });

export const idParamSchema = z.object({ id: uuid });

/* ----------------------------------------- mind maps ----------------------------------------- */

export interface MindmapNode {
  id: string;
  label: string;
  /** One short sentence that explains the branch (optional). */
  note?: string;
  children: MindmapNode[];
}

export const mindmapNodeSchema: z.ZodType<MindmapNode> = z.lazy(
  () =>
    z.object({
      id: z.string().min(1).max(40),
      label: z.string().min(1).max(STUDY_TOOLS_LIMITS.labelMaxChars),
      note: z.string().max(STUDY_TOOLS_LIMITS.noteMaxChars).optional(),
      children: z
        .array(mindmapNodeSchema)
        .max(STUDY_TOOLS_LIMITS.maxChildren),
    }) as z.ZodType<MindmapNode>,
);

export const mindmapSizeSchema = z.enum(["small", "medium", "large"]);
export type MindmapSize = z.infer<typeof mindmapSizeSchema>;

export const generateMindmapInputSchema = z
  .object({
    source: studySourceSchema,
    size: mindmapSizeSchema.default("medium"),
    title: text(STUDY_TOOLS_LIMITS.titleMaxChars).optional(),
  })
  .strict();
export type GenerateMindmapInput = z.infer<typeof generateMindmapInputSchema>;

export const mindmapSchema = z.object({
  id: uuid,
  title: z.string(),
  sourceType: z.enum(["notes", "topic"]),
  size: mindmapSizeSchema,
  status: generationStatusSchema,
  error: z.string().nullable(),
  isMock: z.boolean(),
  nodeCount: z.number().int().nonnegative(),
  /** Null while generating, on error, and in list responses. */
  tree: mindmapNodeSchema.nullable(),
  createdAt: z.string(),
});
export type Mindmap = z.infer<typeof mindmapSchema>;

export const mindmapListResponseSchema = z.object({ mindmaps: z.array(mindmapSchema) });
export const mindmapResponseSchema = z.object({ mindmap: mindmapSchema });
export type MindmapListResponse = z.infer<typeof mindmapListResponseSchema>;

/** How many nodes the AI is asked for per size (a hint to the model; the server enforces STUDY_TOOLS_LIMITS regardless). */
export const MINDMAP_SIZE_TARGET: Record<MindmapSize, { branches: number; nodes: number }> = {
  small: { branches: 4, nodes: 14 },
  medium: { branches: 6, nodes: 28 },
  large: { branches: 8, nodes: 48 },
};
