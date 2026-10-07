import { z } from "zod";

/** Limits enforced by the API and mirrored in the UI for early feedback. */
export const QUIZ_LIMITS = {
  /** Question counts offered in the UI. The API accepts any whole number from 1 to `maxQuestions`. */
  countOptions: [5, 10, 15, 20],
  defaultCount: 5,
  maxQuestions: 20,
  maxNotes: 5,
  subjectMaxChars: 100,
  topicMaxChars: 100,
  focusMaxChars: 200,
  /** Optional timer choices (minutes). `null` = untimed. The API accepts 1 to `maxTimeLimitMinutes`. */
  timeLimitOptions: [null, 10, 20, 30, 60],
  maxTimeLimitMinutes: 180,
} as const;

/** All question types the database can store. */
export const QUESTION_TYPES = ["mcq", "true_false", "short_answer", "numerical"] as const;
export const questionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof questionTypeSchema>;

/** Types the generator and the quiz player support today (short answer / numerical come later). */
export const GENERATABLE_QUESTION_TYPES = ["mcq", "true_false"] as const;
export const generatableQuestionTypeSchema = z.enum(GENERATABLE_QUESTION_TYPES);
export type GeneratableQuestionType = z.infer<typeof generatableQuestionTypeSchema>;

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  mcq: "Multiple choice",
  true_false: "True / False",
  short_answer: "Short answer",
  numerical: "Numerical",
};

export const DIFFICULTIES = ["easy", "medium", "hard", "mixed"] as const;
export const difficultySchema = z.enum(DIFFICULTIES);
export type Difficulty = z.infer<typeof difficultySchema>;
/** A single question is never "mixed". */
export const questionDifficultySchema = z.enum(["easy", "medium", "hard"]);
export type QuestionDifficulty = z.infer<typeof questionDifficultySchema>;

export const quizStatusSchema = z.enum(["generating", "ready", "failed"]);
export type QuizStatus = z.infer<typeof quizStatusSchema>;
export const attemptStatusSchema = z.enum(["in_progress", "submitted", "expired"]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export const quizSourceTypeSchema = z.enum(["notes", "topic"]);
export type QuizSourceType = z.infer<typeof quizSourceTypeSchema>;

const isoTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

/* ------------------------------------ creating a quiz ------------------------------------ */

const text = (max: number) => z.string().trim().max(max);

export const generateQuizInputSchema = z.object({
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("notes"),
      documentIds: z.array(uuid).min(1, "Choose at least one note").max(QUIZ_LIMITS.maxNotes, `Choose at most ${QUIZ_LIMITS.maxNotes} notes`),
      /** Optional: only quiz on this part of the notes. */
      focus: text(QUIZ_LIMITS.focusMaxChars).optional(),
    }),
    z.object({
      type: z.literal("topic"),
      subject: text(QUIZ_LIMITS.subjectMaxChars).min(1, "Enter a subject"),
      topic: text(QUIZ_LIMITS.topicMaxChars).optional(),
    }),
  ]),
  difficulty: difficultySchema.default("medium"),
  count: z.number().int().min(1, "Choose at least 1 question").max(QUIZ_LIMITS.maxQuestions, `Choose at most ${QUIZ_LIMITS.maxQuestions} questions`).default(QUIZ_LIMITS.defaultCount),
  questionTypes: z
    .array(generatableQuestionTypeSchema)
    .min(1, "Choose at least one question type")
    .refine((t) => new Set(t).size === t.length, "Question types must be unique")
    .default(["mcq"]),
  /** Optional timer in minutes. The deadline is kept and enforced on the server. */
  timeLimitMinutes: z.number().int().min(1).max(QUIZ_LIMITS.maxTimeLimitMinutes).nullable().default(null),
});
export type GenerateQuizInput = z.infer<typeof generateQuizInputSchema>;

/** What the "create quiz" screen can offer: only things this student really has. */
export const quizOptionsSchema = z.object({
  notes: z.array(z.object({ id: uuid, title: z.string(), chunkCount: z.number().int(), pageCount: z.number().int().nullable() })),
  /** Subjects/topics the student has already studied with the AI Tutor (suggestions only). */
  topics: z.array(z.object({ subject: z.string(), topic: z.string().nullable() })),
});
export type QuizOptions = z.infer<typeof quizOptionsSchema>;

/* -------------------------------------- quiz summaries -------------------------------------- */

/** What a quiz that is still being created is doing right now. Real job state, reported as it happens. */
export const generationProgressSchema = z.object({
  stage: z.enum(["preparing", "generating", "checking", "finalizing"]),
  /** Which model call is running (1-based); 0 before the first. */
  batch: z.number().int().nonnegative(),
  /** Questions that have passed every check so far. */
  accepted: z.number().int().nonnegative(),
  target: z.number().int().positive(),
});
export type GenerationProgress = z.infer<typeof generationProgressSchema>;

export const quizSchema = z.object({
  id: uuid,
  title: z.string(),
  sourceType: quizSourceTypeSchema,
  /** Human-readable source: note titles, or "Subject · Topic". */
  sourceLabel: z.string(),
  subject: z.string().nullable(),
  topic: z.string().nullable(),
  sources: z.array(z.object({ id: uuid, title: z.string() })),
  difficulty: difficultySchema,
  questionCount: z.number().int(),
  questionTypes: z.array(questionTypeSchema),
  timeLimitMinutes: z.number().int().nullable(),
  status: quizStatusSchema,
  /** Safe, student-readable reason when generation failed. */
  error: z.string().nullable(),
  /** True when the questions came from the demo (mock) provider, not a real model. */
  isMock: z.boolean(),
  model: z.string().nullable(),
  createdAt: isoTime,
  attemptCount: z.number().int(),
  /** Best score across submitted attempts. */
  bestPercentage: z.number().nullable(),
  lastAttemptAt: isoTime.nullable(),
  /** An attempt the student started and has not submitted (so the UI can offer "Resume"). */
  inProgressAttemptId: uuid.nullable(),
  /** Present only while status is "generating" and this server is running the job; otherwise absent. */
  progress: generationProgressSchema.nullish(),
});
export type Quiz = z.infer<typeof quizSchema>;

/**
 * A question as the player sees it. There is deliberately NO correct answer and NO explanation
 * here: they only exist in the result, after the attempt is submitted.
 */
export const playQuestionSchema = z.object({
  id: uuid,
  order: z.number().int().nonnegative(),
  type: questionTypeSchema,
  text: z.string(),
  options: z.array(z.string()),
  difficulty: questionDifficultySchema,
  topic: z.string().nullable(),
});
export type PlayQuestion = z.infer<typeof playQuestionSchema>;

export const attemptSchema = z.object({
  id: uuid,
  quizId: uuid,
  status: attemptStatusSchema,
  startedAt: isoTime,
  expiresAt: isoTime.nullable(),
  submittedAt: isoTime.nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;

export const quizDetailResponseSchema = z.object({
  quiz: quizSchema,
  /** Present once generation finished; never contains answers. */
  questions: z.array(playQuestionSchema),
  attempts: z.array(
    attemptSchema.extend({ score: z.number().int().nullable(), total: z.number().int().nullable(), percentage: z.number().nullable() }),
  ),
});
export type QuizDetailResponse = z.infer<typeof quizDetailResponseSchema>;

export const attemptViewSchema = z.object({
  attempt: attemptSchema,
  quiz: z.object({ id: uuid, title: z.string(), timeLimitMinutes: z.number().int().nullable(), isMock: z.boolean(), model: z.string().nullable() }),
  /** In the order THIS attempt presents them. */
  questions: z.array(playQuestionSchema),
  /** The student's saved choices so far: question id -> option index. */
  answers: z.record(z.string(), z.number().int()),
  /** Server clock, so a timer can be shown without trusting the browser's clock. */
  serverNow: isoTime,
});
export type AttemptView = z.infer<typeof attemptViewSchema>;

export const saveAnswersInputSchema = z.object({
  answers: z
    .array(z.object({ questionId: uuid, selected: z.number().int().min(0).max(9).nullable() }))
    .max(QUIZ_LIMITS.maxQuestions),
});
export type SaveAnswersInput = z.infer<typeof saveAnswersInputSchema>;

/** Submitting may carry the final answers too, so a failed autosave can never lose them. */
export const submitAttemptInputSchema = saveAnswersInputSchema.partial().default({});
export type SubmitAttemptInput = z.infer<typeof submitAttemptInputSchema>;

/* ------------------------------------------ results ------------------------------------------ */

export const reviewItemSchema = z.object({
  id: uuid,
  order: z.number().int().nonnegative(),
  type: questionTypeSchema,
  text: z.string(),
  options: z.array(z.string()),
  selected: z.number().int().nullable(),
  correctAnswer: z.number().int(),
  isCorrect: z.boolean(),
  explanation: z.string(),
  topic: z.string().nullable(),
  difficulty: questionDifficultySchema,
  /** Where in the notes the question came from (only from real stored metadata). */
  source: z
    .object({
      documentId: uuid.nullable(),
      title: z.string().nullable(),
      page: z.number().int().nullable(),
      heading: z.string().nullable(),
      /** The sentence from the notes that supports the answer (verified at generation time). */
      evidence: z.string().nullable().optional(),
    })
    .nullable(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const topicPerformanceSchema = z.object({
  /** null = the question had no reliably known topic. */
  topic: z.string().nullable(),
  correct: z.number().int(),
  total: z.number().int(),
  percentage: z.number(),
});
export type TopicPerformance = z.infer<typeof topicPerformanceSchema>;

export const resultSchema = z.object({
  attempt: attemptSchema.extend({
    score: z.number().int(),
    total: z.number().int(),
    percentage: z.number(),
    correct: z.number().int(),
    incorrect: z.number().int(),
    unanswered: z.number().int(),
    timeTakenSeconds: z.number().int().nullable(),
    /** True when this call finalised the attempt after its deadline passed. */
    timedOut: z.boolean(),
  }),
  quiz: quizSchema,
  review: z.array(reviewItemSchema),
  topics: z.array(topicPerformanceSchema),
});
export type QuizResult = z.infer<typeof resultSchema>;

/* ------------------------------------- history and summary ------------------------------------- */

export const attemptHistoryItemSchema = z.object({
  id: uuid,
  quizId: uuid,
  quizTitle: z.string(),
  sourceType: quizSourceTypeSchema,
  sourceLabel: z.string(),
  difficulty: difficultySchema,
  questionCount: z.number().int(),
  status: attemptStatusSchema,
  startedAt: isoTime,
  submittedAt: isoTime.nullable(),
  score: z.number().int().nullable(),
  total: z.number().int().nullable(),
  percentage: z.number().nullable(),
});
export type AttemptHistoryItem = z.infer<typeof attemptHistoryItemSchema>;

export const quizSummarySchema = z.object({
  quizzesCreated: z.number().int(),
  attemptsCompleted: z.number().int(),
  averagePercentage: z.number().nullable(),
  bestPercentage: z.number().nullable(),
  questionsAnswered: z.number().int(),
  /** Across ALL submitted attempts, lowest accuracy first. Real data only. */
  topics: z.array(topicPerformanceSchema),
});
export type QuizSummary = z.infer<typeof quizSummarySchema>;

export const quizListResponseSchema = z.object({ quizzes: z.array(quizSchema), summary: quizSummarySchema });
export const attemptListResponseSchema = z.object({ attempts: z.array(attemptHistoryItemSchema) });
export const generateQuizResponseSchema = z.object({ quiz: quizSchema });
export const quizIdParamSchema = z.object({ id: uuid });
