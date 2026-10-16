import type { Env } from "../../config/env.js";
import { GeminiProvider } from "./free/gemini.js";
import { AIError, PolicyViolation } from "./errors.js";
import type { LLMProvider } from "./types.js";
import type { AiStatusReport } from "@copilot/shared";

type ProviderEnv = Pick<Env, "AI_PROVIDER" | "AI_TIMEOUT_MS"> & Partial<Pick<Env, "GEMINI_API_KEY" | "GEMINI_MODEL" | "GEMINI_BILLING_DISABLED">>;

/** Creates the sole enabled provider. Missing credentials or an unapproved model fail before serving requests. */
export function createLLMProvider(env: ProviderEnv, fetchImpl?: typeof fetch): LLMProvider {
  if (env.AI_PROVIDER !== "gemini") throw new PolicyViolation("Only Google Gemini is enabled; no provider fallback is configured.");
  if (!env.GEMINI_API_KEY) throw new PolicyViolation("GEMINI_API_KEY is required to start the Gemini provider.");
  if (env.GEMINI_BILLING_DISABLED !== true) throw new PolicyViolation("Google project billing must be confirmed disabled before starting Gemini.");
  if (!env.GEMINI_MODEL) throw new PolicyViolation("GEMINI_MODEL must be explicitly configured and verified as free before AI can start.");
  return new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function createDisabledLLMProvider(): LLMProvider {
  const unavailable = () => new AIError("unavailable", "AI is disabled for this deployment. No AI provider was contacted.");
  const countersSince = new Date().toISOString();
  const status: AiStatusReport = {
    mode: "disabled",
    localPosition: null,
    lastAnswered: null,
    countersSince,
    steps: [{
      order: 1,
      service: "AI disabled",
      model: "none",
      where: "disabled",
      state: "not_running",
      restingSeconds: 0,
      usedToday: 0,
      limitPerMinute: null,
      limitPerDay: null,
      limitNote: "AI is disabled for this deployment. No prompts or study content are sent to an AI provider.",
      lastResult: null,
      lastAt: null,
    }],
  };
  return {
    name: "disabled",
    model: "disabled",
    isMock: false,
    generateText: async () => {
      throw unavailable();
    },
    async *streamText() {
      throw unavailable();
    },
    status: async () => status,
  };
}

export { AIError } from "./errors.js";
export { PolicyViolation } from "./errors.js";
export type { LLMProvider, GenerateTextRequest, GenerateTextResult, TextStream } from "./types.js";
