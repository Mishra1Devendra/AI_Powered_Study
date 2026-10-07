import { AIError, type LLMProvider } from "../services/ai/index.js";
import { buildExplainPrompt, type ExplainFacts } from "../services/ai/recommendations/prompt.js";
import { parsePlanJson } from "../planner/topics.js";

/** A short structured answer, but a local model on a modest CPU can still take a while. */
export const EXPLAIN_CALL_TIMEOUT_MS = 3 * 60_000;

export interface Explanation {
  overview: string | null;
  items: Array<{ id: string; text: string }>;
  isMock: boolean;
  model: string;
}

export type ExplainOutcome = { ok: true; value: Explanation } | { ok: false; reason: "unavailable" | "unusable" | "timeout" };

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const NUMBER = /\d+(?:\.\d+)?/g;

/** A small model sometimes breaks the JSON around otherwise good items: recover the complete id/text pairs and the overview. */
function salvage(text: string): { overview?: string; items: Array<{ id: string; text: string }> } | null {
  const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
  const items = [...text.matchAll(new RegExp(String.raw`"id"\s*:\s*${STR}\s*,\s*"text"\s*:\s*${STR}`, "g"))].map((m) => ({ id: m[1]!, text: m[2]! }));
  const overview = new RegExp(String.raw`"overview"\s*:\s*${STR}`).exec(text)?.[1];
  return items.length > 0 || overview ? { ...(overview ? { overview } : {}), items } : null;
}

/** Every number the model was given. Its text may use these and no others. */
export function allowedNumbers(facts: ExplainFacts): Set<string> {
  const allowed = new Set<string>();
  for (const m of JSON.stringify(facts).matchAll(NUMBER)) allowed.add(m[0].replace(/^0+(?=\d)/, ""));
  // Plain whole numbers from a date such as 2026-10-17 are covered above; spelled-out counts ("one") contain no digits.
  return allowed;
}

/** false when the text contains a number that is not in the supplied facts (an invented score, count or date). */
export const usesOnlyGivenNumbers = (text: string, allowed: Set<string>) => [...text.matchAll(NUMBER)].every((m) => allowed.has(m[0].replace(/^0+(?=\d)/, "")));

/**
 * ONE model call (no retry - a failure just means the page keeps showing the deterministic recommendations). The answer
 * is kept only where it is safe: ids must be ones we sent, texts are cleaned and length-limited, and any text with a
 * number that is not in the facts is dropped.
 */
export async function explainRecommendations(ai: LLMProvider, facts: ExplainFacts, signal?: AbortSignal): Promise<ExplainOutcome> {
  const prompt = buildExplainPrompt(facts);
  let result;
  try {
    result = await ai.generateText({ system: prompt.system, messages: prompt.messages, json: true, temperature: 0.3, maxTokens: 700, timeoutMs: EXPLAIN_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted || (err instanceof AIError && err.code === "timeout")) return { ok: false, reason: "timeout" };
    if (err instanceof AIError) return { ok: false, reason: "unavailable" };
    throw err;
  }
  // Read the reply two ways and use both: a normal parse, and a scan for complete id/text pairs. A small model sometimes
  // repeats the "items" key (a normal parse then keeps only the LAST one) or breaks the JSON around good items.
  const parsed = parsePlanJson(result.text);
  const rescued = salvage(result.text);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { overview?: unknown; items?: unknown }) : null;
  if (!object && !rescued) return { ok: false, reason: "unusable" };
  const r = { overview: object?.overview ?? rescued?.overview, items: [...(Array.isArray(object?.items) ? (object!.items as unknown[]) : []), ...(rescued?.items ?? [])] };
  const allowed = allowedNumbers(facts);
  const ids = new Set(facts.recommendations.map((x) => x.id));
  const seen = new Set<string>();
  const items: Explanation["items"] = [];
  for (const it of r.items) {
    if (!it || typeof it !== "object") continue;
    const { id, text } = it as { id?: unknown; text?: unknown };
    const body = clean(text, 320);
    if (typeof id !== "string" || !ids.has(id) || seen.has(id) || body.length < 10 || !usesOnlyGivenNumbers(body, allowed)) continue;
    seen.add(id);
    items.push({ id, text: body });
  }
  const overviewText = clean(r.overview, 360);
  const overview = overviewText.length >= 10 && usesOnlyGivenNumbers(overviewText, allowed) ? overviewText : null;
  if (items.length === 0 && overview === null) return { ok: false, reason: "unusable" };
  return { ok: true, value: { overview, items, isMock: result.isMock, model: result.model } };
}
