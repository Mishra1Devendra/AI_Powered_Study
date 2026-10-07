import { z } from "zod";

/**
 * What an ADMINISTRATOR sees about the AI: which services are in the chain, which one answered last, and each one's free limit.
 * Students and the public health check never get this (they only see the generic "free-ai" label); the endpoint that returns it
 * requires an admin. Contains no keys, prompts or answers.
 */
export const aiStepStatusSchema = z.object({
  order: z.number().int().positive(),
  /** Display name of the service, e.g. "Local AI (Ollama)" or an approved free online service. */
  service: z.string(),
  model: z.string(),
  where: z.enum(["this_computer", "online"]),
  /** ready = will be tried; resting = it just hit a limit or failed and is being skipped for a short while; not_running = the local AI is off. */
  state: z.enum(["ready", "resting", "not_running"]),
  restingSeconds: z.number().int().nonnegative(),
  /** Requests started with this service today (UTC day) since the server last started. */
  usedToday: z.number().int().nonnegative(),
  /** The free limits from the provider's own documentation; null where the provider does not publish a number. */
  limitPerMinute: z.number().int().nullable(),
  limitPerDay: z.number().int().nullable(),
  limitNote: z.string(),
  /** "ok" or the kind of failure of the last attempt (rate_limited, unavailable, ...); null if never tried. */
  lastResult: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type AiStepStatus = z.infer<typeof aiStepStatusSchema>;

export const aiStatusSchema = z.object({
  mode: z.enum(["free", "ollama", "mock"]),
  /** Where the local AI sits in the chain ("free" mode only). */
  localPosition: z.enum(["first", "last"]).nullable(),
  /** The service and model that produced the most recent answer since the server started; null if none yet. */
  lastAnswered: z.object({ service: z.string(), model: z.string(), at: z.string() }).nullable(),
  steps: z.array(aiStepStatusSchema),
  /** Counters start from zero when the server starts and are not stored. */
  countersSince: z.string(),
});
export type AiStatusReport = z.infer<typeof aiStatusSchema>;
