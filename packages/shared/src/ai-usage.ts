import { z } from "zod";

/**
 * Daily AI allowance. Every action that asks the AI for something costs a few "uses"; a student has a fixed number per day
 * (UTC day), and administrators have no limit. The free AI services have free-tier quotas, so one student must not be able to use
 * them all up. Reading, studying cards, taking a quiz and so on cost nothing: only the actions below ask the AI.
 */
export const AI_FEATURES = ["tutor", "notes", "quiz", "planner", "check", "viva", "recommendations", "flashcards", "mindmap"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Uses charged per action (a bigger job asks the AI for more). */
export const AI_COST: Record<AiFeature, number> = {
  tutor: 1, // one tutor reply (also "regenerate")
  notes: 1, // one answer about a note (also "regenerate")
  viva: 1, // one viva question or one evaluated answer
  recommendations: 1, // "Explain my priorities"
  check: 1, // the 5 questions before completing a study session
  planner: 2, // a study plan
  flashcards: 2, // a deck of cards
  mindmap: 2, // a mind map
  quiz: 3, // a quiz (several questions, written in batches)
};

export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  tutor: "AI Tutor",
  notes: "Notes assistant",
  quiz: "Quiz",
  planner: "Study plan",
  check: "Study check",
  viva: "Viva",
  recommendations: "Recommendations",
  flashcards: "Flashcards",
  mindmap: "Mind map",
};

/** The default daily allowance for a student; the server's `AI_DAILY_UNITS` setting overrides it. */
export const DEFAULT_AI_DAILY_UNITS = 100;

export const AI_LIMIT_CODE = "ai_limit_reached";

export const aiUsageSchema = z.object({
  /** True for administrators: no daily limit. */
  unlimited: z.boolean(),
  /** The daily allowance (null when unlimited). */
  limit: z.number().int().nullable(),
  /** Uses spent today. */
  used: z.number().int().nonnegative(),
  /** Uses left today (null when unlimited). */
  remaining: z.number().int().nonnegative().nullable(),
  /** When the allowance starts again (ISO, the next UTC midnight). */
  resetsAt: z.string(),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;
