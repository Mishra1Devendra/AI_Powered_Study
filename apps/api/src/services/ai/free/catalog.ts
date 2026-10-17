import { PolicyViolation } from "../errors.js";

/**
 * Provider/model catalog retained for legacy adapter tests. Only Gemini is selected by the active factory.
 * Gemini 3.5 Flash-Lite has free-tier token pricing in Google's pricing documentation. The Google project must still have
 * billing disabled so requests cannot move to a paid tier when free-tier quotas are exhausted.
 *
 *   Gemini model eligibility: gemini-3.5-flash-lite is approved for free-tier token use.
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
  gemini: { id: "gemini", origin: "https://generativelanguage.googleapis.com", models: ["gemini-3.5-flash-lite"], defaultModel: "gemini-3.5-flash-lite", freeTierMayTrainOnContent: true, displayName: "Google Gemini", limits: { perMinute: null, perDay: null, note: "Free-tier quotas are account-specific. Disable Google Cloud billing to prevent paid-tier usage." } },
  openrouter: { id: "openrouter", origin: "https://openrouter.ai", models: [], defaultModel: null, freeTierMayTrainOnContent: true, displayName: "OpenRouter", limits: { perMinute: 20, perDay: 50, note: "Free (:free) models without bought credits: 20 requests/min, 50/day. Over the limit gives an error, never a charge." } },
};

/** Historical provider order; the active Gemini-only factory does not use this chain. */
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
