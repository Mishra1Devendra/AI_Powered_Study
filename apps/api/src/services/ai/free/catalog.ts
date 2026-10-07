import { PolicyViolation } from "../ollama-provider.js";

/**
 * THE APPROVED FREE-AI LIST (project policy: free only, never paid, never a card). A provider appears here only after its specific
 * model/endpoint was checked against the provider's OFFICIAL documentation. Nothing outside this list can be called: the host is
 * fixed here (never configurable), and a model must be on the provider's approved list.
 *
 *   Provider   Model(s)                                  Free tier (official docs, checked 2026-10-06)             Card  Paid fallback
 *   groq       openai/gpt-oss-20b, openai/gpt-oss-120b   Free plan, rate limited; over the limit = HTTP 429         NO    NO
 *   gemini     gemini-3.5-flash-lite (default) and the other   Free tier on the key's project; over limit = HTTP 429   NO    NO
 *              3.x / 2.5 flash models listed below   ("Free of charge" on Google's official pricing page, checked 2026-10-06)
 *   openrouter any model whose id ends in ":free"        ":free" models cannot be billed; over limit = HTTP 429     NO    NO
 *
 * Deliberately NOT here (could not be confirmed free from official pages, so by policy they are not used): Cloudflare Workers AI,
 * Mistral, Cerebras, Hugging Face. Add one only after verifying the exact model, that no card is needed, and what happens when the
 * free allowance ends.
 *
 * Gemini caveat that code cannot check: the API key must belong to a Google project WITHOUT billing enabled; a billed project
 * would turn the same key into a paid one. Create it in a fresh AI Studio project and never enable billing on it.
 */
export type FreeProviderId = "groq" | "gemini" | "openrouter";

export interface FreeProviderSpec {
  id: FreeProviderId;
  /** Fixed API origin. Never read from configuration. */
  origin: string;
  /** Models approved as free (exact ids). OpenRouter is validated by the ":free" suffix instead. */
  models: readonly string[];
  defaultModel: string | null;
  /** Free-tier content may be used by the provider to improve its products (shown to the owner in the docs). */
  freeTierMayTrainOnContent: boolean;
  /** Shown to administrators only. */
  displayName: string;
  /** Free limits from the provider's official documentation (null where no number is published). */
  limits: { perMinute: number | null; perDay: number | null; note: string };
}

export const FREE_PROVIDERS: Record<FreeProviderId, FreeProviderSpec> = {
  groq: { id: "groq", origin: "https://api.groq.com", models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"], defaultModel: "openai/gpt-oss-20b", freeTierMayTrainOnContent: false, displayName: "Groq", limits: { perMinute: 30, perDay: 1000, note: "Free plan limits for these models (30 requests/min, 1,000/day). Over the limit gives an error, never a charge." } },
  gemini: { id: "gemini", origin: "https://generativelanguage.googleapis.com", models: ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"], defaultModel: "gemini-3.5-flash-lite", freeTierMayTrainOnContent: true, displayName: "Google Gemini", limits: { perMinute: null, perDay: null, note: "Set per project and shown in Google AI Studio (Google does not publish fixed numbers). Over the limit gives an error, never a charge." } },
  openrouter: { id: "openrouter", origin: "https://openrouter.ai", models: [], defaultModel: null, freeTierMayTrainOnContent: true, displayName: "OpenRouter", limits: { perMinute: 20, perDay: 50, note: "Free (:free) models without bought credits: 20 requests/min, 50/day. Over the limit gives an error, never a charge." } },
};

/** The default order after local Ollama: private-by-default and fastest first, the provider that may train on free-tier content last. */
export const DEFAULT_FREE_ORDER: readonly FreeProviderId[] = ["groq", "openrouter", "gemini"];

export const isFreeProviderId = (v: string): v is FreeProviderId => v === "groq" || v === "gemini" || v === "openrouter";

/** Throws unless `model` is explicitly approved as FREE for this provider. There is no "auto" / default-routing option. */
export function assertApprovedFreeModel(id: FreeProviderId, model: string): string {
  const spec = FREE_PROVIDERS[id];
  const m = model.trim();
  if (id === "openrouter") {
    // Only ids ending in ":free". An id without the suffix may be a paid model, and routers/"auto" ids are never accepted.
    if (!/^[\w.\-]+\/[\w.\-:]+:free$/.test(m)) throw new PolicyViolation(`The OpenRouter model must be an explicit ":free" model id (got "${m.slice(0, 60)}"). Paid or auto-routed models are not allowed.`);
    return m;
  }
  if (!spec.models.includes(m)) throw new PolicyViolation(`"${m.slice(0, 60)}" is not an approved free ${id} model. Approved: ${spec.models.join(", ")}.`);
  return m;
}
