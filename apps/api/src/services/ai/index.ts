import type { Env } from "../../config/env.js";
import { OllamaOrMockProvider } from "./mock-fallback.js";
import { MockProvider } from "./mock-provider.js";
import { DEFAULT_FREE_ORDER, FREE_PROVIDERS, isFreeProviderId, type FreeProviderId } from "./free/catalog.js";
import { FreeAiChainProvider, type FreeSlot } from "./free/chain.js";
import { ChatCompletionsProvider } from "./free/chat-completions.js";
import { GeminiFreeProvider } from "./free/gemini.js";
import { OllamaProvider, PolicyViolation } from "./ollama-provider.js";
import type { LLMProvider } from "./types.js";

type ProviderEnv = Pick<Env, "AI_PROVIDER" | "OLLAMA_BASE_URL" | "OLLAMA_MODEL" | "OLLAMA_NUM_CTX" | "AI_TIMEOUT_MS"> &
  Partial<Pick<Env, "FREE_AI_ORDER" | "FREE_AI_LOCAL_POSITION" | "GROQ_API_KEY" | "GROQ_MODEL" | "GEMINI_API_KEY" | "GEMINI_MODEL" | "OPENROUTER_API_KEY" | "OPENROUTER_MODEL">>;

/** The configured free online services, in order. A service without a key is simply not used. Invalid names/models fail at startup. */
export function buildFreeSlots(env: ProviderEnv, fetchImpl?: typeof fetch): FreeSlot[] {
  const order = (env.FREE_AI_ORDER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const ids: FreeProviderId[] = order.length ? order.map((n) => (isFreeProviderId(n) ? n : fail(n))) : [...DEFAULT_FREE_ORDER];
  const seen = new Set<FreeProviderId>();
  const slots: FreeSlot[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const key = id === "groq" ? env.GROQ_API_KEY : id === "gemini" ? env.GEMINI_API_KEY : env.OPENROUTER_API_KEY;
    if (!key) continue;
    const model = (id === "groq" ? env.GROQ_MODEL : id === "gemini" ? env.GEMINI_MODEL : env.OPENROUTER_MODEL) || FREE_PROVIDERS[id].defaultModel;
    if (!model) throw new PolicyViolation("OPENROUTER_MODEL must be set to an explicit \":free\" model id before OpenRouter can be used.");
    const common = { apiKey: key, model, timeoutMs: env.AI_TIMEOUT_MS, ...(fetchImpl ? { fetchImpl } : {}) };
    slots.push({ label: id, service: FREE_PROVIDERS[id].displayName, model, limits: FREE_PROVIDERS[id].limits, provider: id === "gemini" ? new GeminiFreeProvider(common) : new ChatCompletionsProvider({ ...common, id }) });
  }
  return slots;
}

function fail(name: string): never {
  throw new PolicyViolation(`"${name.slice(0, 30)}" is not an approved free AI service. Approved: ${Object.keys(FREE_PROVIDERS).join(", ")}.`);
}

/**
 * Zero-cost providers only. `AI_PROVIDER=ollama` (default): local Ollama, falling back to the
 * labelled mock if Ollama is not running. `AI_PROVIDER=mock`: mock only. There is deliberately
 * no paid provider and no provider chain: see docs/AI_POLICY.md.
 * Throws PolicyViolation if the Ollama URL/model is not provably local.
 */
export function createLLMProvider(env: ProviderEnv): LLMProvider {
  if (env.AI_PROVIDER === "mock") return new MockProvider();
  if (env.AI_PROVIDER === "free") {
    const local = new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, timeoutMs: env.AI_TIMEOUT_MS, numCtx: env.OLLAMA_NUM_CTX });
    return new FreeAiChainProvider({ local, slots: buildFreeSlots(env), localPosition: env.FREE_AI_LOCAL_POSITION ?? "first" });
  }
  return new OllamaOrMockProvider(
    new OllamaProvider({
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
      numCtx: env.OLLAMA_NUM_CTX,
    }),
  );
}

export { AIError } from "./errors.js";
export { PolicyViolation } from "./ollama-provider.js";
export type { LLMProvider, GenerateTextRequest, GenerateTextResult, TextStream } from "./types.js";
