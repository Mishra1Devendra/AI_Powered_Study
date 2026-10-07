import { z } from "zod";

/**
 * SMART REVISION & RECOMMENDATIONS - contracts and the documented ranking rules, shared by the API (which calculates
 * everything) and the web app (which only displays it).
 *
 * THE RULE: the application calculates every fact (scores, mistakes, recency, study time, upcoming sessions) from the
 * student's own records and ranks the recommendations deterministically. AI is never asked to calculate anything; it may
 * optionally be asked (by a button press) to put the already-calculated facts into friendlier words, and its text is
 * checked so it cannot add a number that is not in the facts.
 *
 * PRIORITY POINTS (added up, capped at 100; "high" >= 60, "medium" >= 35, otherwise "low"; a weak topic that also has a poor viva,
 * repeated misses or long neglect reaches 80+ and is called "urgent revision"):
 *   quiz accuracy  - Weak (< 50%, 5+ questions) +60 (+ up to 10 more the lower it is) | Needs practice +22 | too few questions +12
 *   repeated miss  - +20 for each question missed in 2+ attempts (max +40)
 *   viva           - average viva score on the topic < 50%: +35 | 50-74%: +12
 *   not practiced  - on a topic that needs work: 7+ days +6, 14+ days +12
 *   upcoming plan  - a planned study session on the topic within 3 days +14, within 7 days +7
 * Topics that are doing well get a small base so they appear last: Improving 20, Strong 8 (+10 if not practiced for 14+ days).
 * Words like "Weak" use the same thresholds as the Progress page (PROGRESS_THRESHOLDS).
 */
export const RECOMMENDATION_LIMITS = {
  defaultLimit: 10,
  maxLimit: 30,
  /** Used for the question counts offered by quiz actions. */
  quizCount: 5,
  miniQuizCount: 5,
  vivaCount: 5,
  /** A topic not practiced for this many days counts as "not practiced recently". */
  staleDays: 7,
  veryStaleDays: 14,
  /** How many recommendations the optional AI explanation covers. */
  explainCount: 5,
} as const;

export const RECOMMENDATION_TYPES = ["URGENT_REVISION", "WEAK_TOPIC", "REPEATED_MISTAKE", "PRACTICE_MORE", "VIVA_PRACTICE", "UPCOMING_STUDY", "IMPROVING", "MAINTAIN_STRENGTH"] as const;
export const recommendationTypeSchema = z.enum(RECOMMENDATION_TYPES);
export type RecommendationType = z.infer<typeof recommendationTypeSchema>;

export const RECOMMENDATION_PRIORITIES = ["high", "medium", "low"] as const;
export const recommendationPrioritySchema = z.enum(RECOMMENDATION_PRIORITIES);
export type RecommendationPriority = z.infer<typeof recommendationPrioritySchema>;

export const priorityFor = (points: number): RecommendationPriority => (points >= 60 ? "high" : points >= 35 ? "medium" : "low");

/** Which page section a recommendation belongs to. */
export const RECOMMENDATION_SECTIONS = ["weak", "repeated", "practice", "improving", "strong"] as const;
export type RecommendationSection = (typeof RECOMMENDATION_SECTIONS)[number];
export const SECTION_OF_TYPE: Record<RecommendationType, RecommendationSection> = {
  URGENT_REVISION: "weak",
  WEAK_TOPIC: "weak",
  REPEATED_MISTAKE: "repeated",
  PRACTICE_MORE: "practice",
  VIVA_PRACTICE: "practice",
  UPCOMING_STUDY: "practice",
  IMPROVING: "improving",
  MAINTAIN_STRENGTH: "strong",
};
export const SECTION_LABEL: Record<RecommendationSection, string> = {
  weak: "Weak topics",
  repeated: "Repeated mistakes",
  practice: "Needs practice",
  improving: "Improving",
  strong: "Strong topics",
};
export const TYPE_LABEL: Record<RecommendationType, string> = {
  URGENT_REVISION: "Urgent revision",
  WEAK_TOPIC: "Weak topic",
  REPEATED_MISTAKE: "Repeated mistake",
  PRACTICE_MORE: "Needs practice",
  VIVA_PRACTICE: "Viva practice",
  UPCOMING_STUDY: "Planned study",
  IMPROVING: "Improving",
  MAINTAIN_STRENGTH: "Strength",
};

export const ACTION_KINDS = ["quiz", "tutor", "viva", "notes", "plan"] as const;
export const actionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof actionKindSchema>;

/**
 * What a button does. The server only says WHAT to open and with which text; the web app builds the in-app link or
 * hands the text to the existing screen. Nothing here ever starts anything: a quiz, viva or tutor message is only
 * created when the student presses the button on that screen.
 */
export const recommendationActionSchema = z.object({
  kind: actionKindSchema,
  label: z.string(),
  subject: z.string().nullable(),
  topic: z.string().nullable(),
  /** quiz / viva: the suggested size. */
  count: z.number().int().nullable(),
  /** tutor: the suggested question (put into the composer, not sent). */
  draft: z.string().nullable(),
  /** notes: a note that the topic's quiz questions were made from. */
  documentId: z.string().uuid().nullable(),
  /** plan: the planned session to open. */
  sessionId: z.string().uuid().nullable(),
});
export type RecommendationAction = z.infer<typeof recommendationActionSchema>;

export const recommendationFactsSchema = z.object({
  /** Quiz accuracy over all finished attempts (null when there are too few questions for a percentage). */
  accuracy: z.number().min(0).max(100).nullable(),
  questions: z.number().int().min(0),
  attempts: z.number().int().min(0),
  /** Questions the student got wrong in two or more attempts. */
  repeatedMisses: z.number().int().min(0),
  daysSincePracticed: z.number().int().min(0).nullable(),
  vivaAverage: z.number().min(0).max(100).nullable(),
  vivaSessions: z.number().int().min(0),
  trend: z.object({ previous: z.number(), recent: z.number() }).nullable(),
  scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type RecommendationFacts = z.infer<typeof recommendationFactsSchema>;

export const recommendationSchema = z.object({
  /** Stable for the same topic and type, e.g. "WEAK_TOPIC:integration". */
  id: z.string(),
  type: recommendationTypeSchema,
  priority: recommendationPrioritySchema,
  subject: z.string().nullable(),
  topic: z.string().nullable(),
  title: z.string(),
  /** Why, written from the facts below (deterministic - no AI). */
  reason: z.string(),
  /** The suggested action in words, e.g. "Practice 5 questions". */
  actionText: z.string(),
  /** The main button. */
  primary: actionKindSchema,
  actions: z.array(recommendationActionSchema).min(1).max(5),
  facts: recommendationFactsSchema,
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const recommendationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECOMMENDATION_LIMITS.maxLimit).default(RECOMMENDATION_LIMITS.defaultLimit),
});

export const recommendationsResponseSchema = z.object({
  /** Ranked, most important first. */
  recommendations: z.array(recommendationSchema),
  summary: z.object({
    /** Distinct topics found in the student's quizzes, vivas and plan. */
    topicsAnalyzed: z.number().int().min(0),
    /** Topics with enough quiz questions (or a viva) to say something reliable. */
    topicsWithEnoughData: z.number().int().min(0),
    /** false until there is real learning data to base advice on; the page then explains what is needed. */
    hasEnoughData: z.boolean(),
  }),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type RecommendationsResponse = z.infer<typeof recommendationsResponseSchema>;

/** The optional AI wording. `available: false` is a normal answer (never an error page): the facts above still stand. */
export const explainResponseSchema = z.object({
  available: z.boolean(),
  message: z.string().nullable(),
  overview: z.string().nullable(),
  items: z.array(z.object({ id: z.string(), text: z.string() })),
  isMock: z.boolean(),
  model: z.string().nullable(),
});
export type ExplainResponse = z.infer<typeof explainResponseSchema>;
