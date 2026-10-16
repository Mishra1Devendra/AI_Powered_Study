import { z } from "zod";

export const aiProviderStatusSchema = z.object({
  provider: z.enum(["ollama", "mock", "free-ai", "disabled"]),
  /** True when responses are canned demo output, not a real model. */
  isMock: z.boolean(),
  model: z.string(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  ai: aiProviderStatusSchema,
});

export const readinessResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.object({
    ok: z.boolean(),
    latencyMs: z.number().nullable(),
    /** Generic reason only - never connection strings or driver internals. */
    error: z.string().nullable(),
  }),
  ai: aiProviderStatusSchema.extend({
    /** The local AI server answered a cheap "list models" request (null for the mock: nothing to reach). No generation happens. */
    reachable: z.boolean().nullable().optional(),
    /** The configured model is installed. */
    modelInstalled: z.boolean().nullable().optional(),
  }),
});

export type AiProviderStatus = z.infer<typeof aiProviderStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
