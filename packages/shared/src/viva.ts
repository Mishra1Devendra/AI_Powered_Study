import { z } from "zod";
import { sourceModeSchema } from "./knowledge.js";
import { PROGRESS_THRESHOLDS } from "./progress.js";

/**
 * AI VIVA (text only) - limits, scoring formula and contracts shared by the API and the web app.
 *
 * The student answers an AI examiner's questions in writing. For each answer the local AI returns structured scores
 * (0-10) that the server validates; the server - not the AI - turns them into the percentages below. The AI's
 * judgement is advisory: a small local model can be wrong, and nothing here claims otherwise.
 *
 * SCORE FORMULA (a simple, documented weighting - not scientifically validated):
 *   answer score (0-100) = 10 x (0.40 correctness + 0.30 completeness + 0.20 clarity + 0.10 confidence)
 *   viva score  (0-100)  = the mean of its answer scores
 * "Confidence" is the AI's rough estimate of how assured the written answer sounds. It is not a measurement of the
 * student and has the smallest weight.
 */
export const VIVA_LIMITS = {
  subjectMaxChars: 100,
  topicMaxChars: 100,
  answerMaxChars: 3000,
  minQuestions: 3,
  maxQuestions: 15,
  /** Offered in the form. 5 is recommended: the local model is slow on modest hardware. */
  questionOptions: [5, 10, 15],
  defaultQuestions: 5,
} as const;

export const SCORE_WEIGHTS = { correctness: 0.4, completeness: 0.3, clarity: 0.2, confidence: 0.1 } as const;

export const VIVA_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const vivaDifficultySchema = z.enum(VIVA_DIFFICULTIES);
export type VivaDifficulty = z.infer<typeof vivaDifficultySchema>;
export const VIVA_DIFFICULTY_LABEL: Record<VivaDifficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export const VIVA_STATUSES = ["in_progress", "completed", "abandoned"] as const;
export const vivaStatusSchema = z.enum(VIVA_STATUSES);
export type VivaStatus = z.infer<typeof vivaStatusSchema>;
export const VIVA_STATUS_LABEL: Record<VivaStatus, string> = { in_progress: "In progress", completed: "Completed", abandoned: "Abandoned" };

export const DIMENSIONS = ["correctness", "completeness", "clarity", "confidence"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABEL: Record<Dimension, string> = {
  correctness: "Conceptual understanding",
  completeness: "Completeness",
  clarity: "Clarity",
  confidence: "Confidence (AI estimate)",
};

/** The one place the weighting is applied. Inputs are the AI's 0-10 scores; the result is 0-100, one decimal. */
export function answerScore(s: Record<Dimension, number>): number {
  const raw = 10 * (SCORE_WEIGHTS.correctness * s.correctness + SCORE_WEIGHTS.completeness * s.completeness + SCORE_WEIGHTS.clarity * s.clarity + SCORE_WEIGHTS.confidence * s.confidence);
  return Math.round(raw * 10) / 10;
}

export type ScoreLevel = "strong" | "developing" | "weak";
export const SCORE_LEVEL_LABEL: Record<ScoreLevel, string> = { strong: "Strong", developing: "Needs practice", weak: "Weak" };
/** Same cut-offs as topic mastery on the Progress page. */
export function scoreLevel(percent: number): ScoreLevel {
  return percent >= PROGRESS_THRESHOLDS.strongAtOrAbove ? "strong" : percent < PROGRESS_THRESHOLDS.weakBelow ? "weak" : "developing";
}

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);

export const createVivaInputSchema = z
  .object({
    subject: text(VIVA_LIMITS.subjectMaxChars).min(1, "Enter a subject"),
    topic: text(VIVA_LIMITS.topicMaxChars).optional(),
    difficulty: vivaDifficultySchema,
    questionCount: z.number().int().min(VIVA_LIMITS.minQuestions).max(VIVA_LIMITS.maxQuestions).default(VIVA_LIMITS.defaultQuestions),
    /** Phase 11: where the questions come from. Omitted = "general" (the AI's own knowledge), exactly as before. */
    sourceType: sourceModeSchema.default("general"),
    /** Required for a specific document; verified on the server to be one of the student's own ready documents. */
    documentId: uuid.optional(),
  })
  .refine((v) => v.sourceType !== "document" || Boolean(v.documentId), { message: "Choose a document", path: ["documentId"] });
export type CreateVivaInput = z.infer<typeof createVivaInputSchema>;
/** What a client sends: without a source the viva is "general", exactly as before sources existed. */
export type CreateVivaRequest = Omit<CreateVivaInput, "sourceType" | "documentId"> & { sourceType?: z.infer<typeof sourceModeSchema> | undefined; documentId?: string | undefined };

export const answerVivaInputSchema = z.object({
  questionId: uuid,
  answer: text(VIVA_LIMITS.answerMaxChars).min(1, "Write an answer first"),
});
export type AnswerVivaInput = z.infer<typeof answerVivaInputSchema>;

export const vivaIdParamSchema = z.object({ id: uuid });

const score10 = z.number().int().min(0).max(10);
export const vivaAnswerSchema = z.object({
  answerText: z.string(),
  correctness: score10,
  completeness: score10,
  clarity: score10,
  confidence: score10,
  /** 0-100, calculated by the server from the four scores with SCORE_WEIGHTS. */
  score: z.number().min(0).max(100),
  feedback: z.string(),
  missingConcepts: z.array(z.string()),
  shouldFollowUp: z.boolean(),
  answeredAt: z.string().datetime({ offset: true }),
});
export type VivaAnswer = z.infer<typeof vivaAnswerSchema>;

/** Metadata only - never the passage text, so it cannot leak the answer. */
export const vivaQuestionSourceSchema = z.object({
  documentId: uuid,
  documentTitle: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  page: z.number().int().nullable(),
  heading: z.string().nullable(),
});
export type VivaQuestionSource = z.infer<typeof vivaQuestionSourceSchema>;

export const vivaQuestionSchema = z.object({
  id: uuid,
  number: z.number().int().min(1),
  text: z.string(),
  /** A short label for the idea the question tests. */
  concept: z.string(),
  isFollowUp: z.boolean(),
  /** Phase 11: the passage the question was based on (real document metadata only), or null for a general question. */
  source: vivaQuestionSourceSchema.nullable().optional(),
  /** What a strong answer covers (AI-generated). Only sent once the question has been answered. */
  keyPoints: z.array(z.string()).nullable(),
  answer: vivaAnswerSchema.nullable(),
});
export type VivaQuestion = z.infer<typeof vivaQuestionSchema>;

export const vivaSessionSchema = z.object({
  id: uuid,
  subject: z.string(),
  topic: z.string().nullable(),
  difficulty: vivaDifficultySchema,
  questionCount: z.number().int(),
  status: vivaStatusSchema,
  /** 0-100; only for a completed viva. */
  score: z.number().min(0).max(100).nullable(),
  answeredCount: z.number().int().min(0),
  /** Phase 11: general knowledge, all of the student's notes, or one document (absent on older records = general). */
  sourceType: sourceModeSchema.optional(),
  documentId: uuid.nullable().optional(),
  documentTitle: z.string().nullable().optional(),
  /** true if ANY step was written by the offline demo provider instead of a real model. */
  isMock: z.boolean(),
  model: z.string().nullable(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type VivaSession = z.infer<typeof vivaSessionSchema>;

export const vivaResultSchema = z.object({
  overall: z.number().min(0).max(100),
  level: z.enum(["strong", "developing", "weak"]),
  /** Average of each dimension as a percentage (0-10 scale x 10). */
  dimensions: z.object({ correctness: z.number(), completeness: z.number(), clarity: z.number(), confidence: z.number() }),
  /** Concepts whose answers scored at least the "strong" line. Only from the actual answers. */
  strongAreas: z.array(z.string()),
  /** What the answers showed needs work: missing concepts, low-scoring concepts and the weakest dimension. */
  improveAreas: z.array(z.string()),
  /** Concepts to take to the AI Tutor: low-scoring concepts and the most often missing ones. */
  weakConcepts: z.array(z.string()),
});
export type VivaResult = z.infer<typeof vivaResultSchema>;

export const vivaDetailSchema = z.object({
  session: vivaSessionSchema,
  questions: z.array(vivaQuestionSchema),
  /** Present once the viva is completed. */
  result: vivaResultSchema.nullable(),
});
export type VivaDetail = z.infer<typeof vivaDetailSchema>;

export const vivaListItemSchema = vivaSessionSchema;
export const vivaListResponseSchema = z.object({
  sessions: z.array(vivaSessionSchema),
  summary: z.object({ completed: z.number().int(), averageScore: z.number().nullable() }),
});
export type VivaListResponse = z.infer<typeof vivaListResponseSchema>;

export const vivaOptionsSchema = z.object({
  /** Subjects and topics the student already used with the AI Tutor and quizzes (suggestions only). */
  topics: z.array(z.object({ subject: z.string(), topic: z.string().nullable() })),
  /** Phase 11: the student's own ready documents, for "My notes" / "Specific document" vivas. */
  documents: z.array(z.object({ id: uuid, title: z.string(), chunkCount: z.number().int() })).optional(),
});
export type VivaOptions = z.infer<typeof vivaOptionsSchema>;
