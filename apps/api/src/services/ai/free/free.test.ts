import { describe, expect, it, vi } from "vitest";
import { tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../../../app.js";
import { loadEnv } from "../../../config/env.js";
import type { Database } from "../../../db/client.js";
import { scrubMessage } from "../../../logging.js";
import { createInMemoryNotesRepository } from "../../../notes/testing/memory.js";
import { createInMemoryTutorRepository } from "../../../tutor/testing.js";
import { assessAiCost, formatCostReport } from "../cost-safety.js";
import { AIError } from "../errors.js";
import { createLLMProvider, buildFreeSlots } from "../index.js";
import { PolicyViolation } from "../ollama-provider.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../types.js";
import { FREE_PROVIDERS, assertApprovedFreeModel } from "./catalog.js";
import { ALL_FREE_UNAVAILABLE, FreeAiChainProvider, type FreeSlot } from "./chain.js";
import { ChatCompletionsProvider } from "./chat-completions.js";
import { GeminiFreeProvider } from "./gemini.js";

const KEY = "gsk_TESTKEYTESTKEYTESTKEY1234567890";
const GKEY = "AIzaTESTKEYTESTKEYTESTKEYTESTKEY12345";
const req: GenerateTextRequest = { system: "be brief", messages: [{ role: "user", content: "hi" }] };

const sse = (chunks: string[]) => new Response(new ReadableStream({ start: (c) => (chunks.forEach((t) => c.enqueue(new TextEncoder().encode(t))), c.close()) }), { status: 200 });
const chat = (...texts: string[]) => sse([...texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`), "data: [DONE]\n\n"]);
const gem = (...texts: string[]) => sse(texts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`));
const status = (n: number) => new Response("secret body " + KEY, { status: n });

async function collect(p: LLMProvider, r: GenerateTextRequest = req) {
  let text = "";
  const s = p.streamText(r);
  while (true) {
    const n = await s.next();
    if (n.done) return { text, end: n.value };
    text += n.value;
  }
}

describe("the approved-free catalog", () => {
  it("accepts only explicitly approved free models", () => {
    expect(assertApprovedFreeModel("groq", "openai/gpt-oss-20b")).toBe("openai/gpt-oss-20b");
    expect(assertApprovedFreeModel("gemini", "gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(assertApprovedFreeModel("gemini", "gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(assertApprovedFreeModel("gemini", "gemini-2.5-flash-lite")).toBe("gemini-2.5-flash-lite");
    expect(assertApprovedFreeModel("openrouter", "some-lab/some-model:free")).toBe("some-lab/some-model:free");
  });

  it.each([
    ["groq", "llama-3.3-70b-versatile-paid"],
    ["groq", "auto"],
    ["gemini", "gemini-2.5-pro"],
    ["gemini", ""],
    ["openrouter", "some-lab/some-model"], // no ":free" suffix: could be a paid model
    ["openrouter", "openrouter/auto"], // auto-routing could pick a paid model
    ["openrouter", "x/y:free-but-not"],
    ["openrouter", ":free"],
  ] as const)("refuses %s model %j", (id, model) => {
    expect(() => assertApprovedFreeModel(id, model)).toThrow(PolicyViolation);
  });

  it("fixes each service's origin in code; there is nothing to configure", () => {
    expect(Object.values(FREE_PROVIDERS).map((p) => p.origin).sort()).toEqual(["https://api.groq.com", "https://generativelanguage.googleapis.com", "https://openrouter.ai"]);
  });
});

describe("chat-completions adapter (Groq / OpenRouter)", () => {
  it("sends ONE request to the fixed host with the key in the Authorization header only, the approved model, and no auto-routing", async () => {
    const fetchImpl = vi.fn(async () => chat("Hel", "lo"));
    const p = new ChatCompletionsProvider({ id: "groq", apiKey: KEY, model: "openai/gpt-oss-20b", timeoutMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await p.generateText({ ...req, json: true, maxTokens: 50, temperature: 0.2 });
    expect(out).toMatchObject({ text: "Hello", provider: "free-ai", model: "free-online-ai", isMock: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "openai/gpt-oss-20b", stream: true, max_tokens: 50, temperature: 0.2, response_format: { type: "json_object" } });
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("uses the fixed OpenRouter origin for an explicit :free model", async () => {
    const fetchImpl = vi.fn(async () => chat("ok"));
    const p = new ChatCompletionsProvider({ id: "openrouter", apiKey: "sk-or-v1-TESTTESTTESTTESTTEST", model: "lab/model:free", timeoutMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.generateText(req);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("refuses to be built with a paid/unapproved model or without a key", () => {
    expect(() => new ChatCompletionsProvider({ id: "openrouter", apiKey: KEY, model: "lab/paid-model", timeoutMs: 1 })).toThrow(PolicyViolation);
    expect(() => new ChatCompletionsProvider({ id: "groq", apiKey: "  ", model: "openai/gpt-oss-20b", timeoutMs: 1 })).toThrow(AIError);
  });

  it.each([
    [429, "rate_limited"],
    [402, "rate_limited"], // "payment required" is treated as out of free quota: skip it, never pay
    [401, "auth"],
    [403, "auth"],
    [400, "bad_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("HTTP %i becomes %s, with a message that never contains the key or the provider's response", async (code, expected) => {
    const p = new ChatCompletionsProvider({ id: "groq", apiKey: KEY, model: "openai/gpt-oss-20b", timeoutMs: 5000, fetchImpl: (async () => status(code)) as unknown as typeof fetch });
    const err = await p.generateText(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe(expected);
    expect(String((err as AIError).message)).not.toMatch(/gsk_|secret body|groq/i);
  });

  it("a network failure is 'unavailable' and an empty reply is an error, not a blank answer", async () => {
    const down = new ChatCompletionsProvider({ id: "groq", apiKey: KEY, model: "openai/gpt-oss-20b", timeoutMs: 5000, fetchImpl: (async () => Promise.reject(new TypeError("fetch failed https://api.groq.com " + KEY))) as unknown as typeof fetch });
    const err = (await down.generateText(req).catch((e: unknown) => e)) as AIError;
    expect(err.code).toBe("unavailable");
    expect(err.message).not.toContain(KEY);
    const empty = new ChatCompletionsProvider({ id: "groq", apiKey: KEY, model: "openai/gpt-oss-20b", timeoutMs: 5000, fetchImpl: (async () => chat()) as unknown as typeof fetch });
    expect(((await empty.generateText(req).catch((e: unknown) => e)) as AIError).code).toBe("empty_response");
  });
});

describe("Gemini free adapter", () => {
  it("keeps the key in a header (never the URL), uses the approved model and the fixed host", async () => {
    const fetchImpl = vi.fn(async () => gem("Hi ", "there"));
    const p = new GeminiFreeProvider({ apiKey: GKEY, model: "gemini-2.5-flash-lite", timeoutMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await p.generateText({ ...req, json: true });
    expect(out).toMatchObject({ text: "Hi there", provider: "free-ai", model: "free-online-ai" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse");
    expect(url).not.toContain(GKEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GKEY);
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toBe("be brief");
  });

  it("a paid model is refused at construction; 429 is rate_limited; 403 is auth", async () => {
    expect(() => new GeminiFreeProvider({ apiKey: GKEY, model: "gemini-2.5-pro", timeoutMs: 1 })).toThrow(PolicyViolation);
    for (const [code, expected] of [[429, "rate_limited"], [403, "auth"]] as const) {
      const p = new GeminiFreeProvider({ apiKey: GKEY, model: "gemini-2.5-flash", timeoutMs: 5000, fetchImpl: (async () => status(code)) as unknown as typeof fetch });
      const err = (await p.generateText(req).catch((e: unknown) => e)) as AIError;
      expect(err.code).toBe(expected);
      expect(err.message).not.toMatch(/AIza|secret body|google/i);
    }
  });
});

/* ------------------------------ the provider manager ------------------------------ */

function fake(opts: { fail?: AIError["code"] | null; text?: string; midStreamFail?: boolean }): LLMProvider & { calls: number } {
  const p = {
    name: "free-ai" as const,
    model: "x",
    isMock: false,
    calls: 0,
    async generateText() {
      p.calls++;
      if (opts.fail) throw new AIError(opts.fail, "failed");
      return { text: opts.text ?? "answer", provider: "free-ai" as const, model: "free-online-ai", isMock: false };
    },
    async *streamText(): TextStream {
      p.calls++;
      if (opts.fail) throw new AIError(opts.fail, "failed");
      yield opts.text ?? "answer";
      if (opts.midStreamFail) throw new AIError("unavailable", "lost");
      return { produced: { model: "free-online-ai", isMock: false } };
    },
  };
  return p;
}
const localDown = () => fake({ fail: "local_unavailable" });
const slot = (label: string, p: LLMProvider): FreeSlot => ({ label, provider: p });

describe("FreeAiChainProvider: local first, then each free service in order, never paid", () => {
  it("uses the local model when it is running and never contacts a free online service", async () => {
    const local = fake({ text: "local answer" });
    const a = fake({});
    const chain = new FreeAiChainProvider({ local, slots: [slot("a", a)] });
    expect((await chain.generateText(req)).text).toBe("local answer");
    expect((await collect(chain)).text).toBe("local answer");
    expect(a.calls).toBe(0);
  });

  it("moves to the next free service when one is rate-limited, tries each at most once, and stops at the first success", async () => {
    const a = fake({ fail: "rate_limited" });
    const b = fake({ text: "from b" });
    const c = fake({ text: "from c" });
    const attempts: Array<[number, string]> = [];
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", a), slot("b", b), slot("c", c)], onAttempt: (i) => attempts.push([i.slot, i.outcome]) });
    const out = await chain.generateText(req);
    expect(out).toMatchObject({ text: "from b", provider: "free-ai", model: "free-online-ai" });
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 0]);
    expect(attempts).toEqual([[-1, "local_unavailable"], [0, "rate_limited"], [1, "ok"]]); // -1 = the local model (not running)
  });

  it.each(["rate_limited", "unavailable", "timeout", "auth", "bad_request", "empty_response", "unknown"] as const)("a service failing with %s is skipped, not retried", async (code) => {
    const a = fake({ fail: code });
    const b = fake({ text: "b" });
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", a), slot("b", b)] });
    expect((await chain.generateText(req)).text).toBe("b");
    expect(a.calls).toBe(1);
  });

  it("when every free service fails the student gets the plain message - and nothing else is called", async () => {
    const all = [fake({ fail: "rate_limited" }), fake({ fail: "unavailable" }), fake({ fail: "auth" })];
    const chain = new FreeAiChainProvider({ local: localDown(), slots: all.map((p, i) => slot(String(i), p)) });
    const err = (await chain.generateText(req).catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.message).toBe(ALL_FREE_UNAVAILABLE);
    expect(err.message).toBe("All free AI services are currently unavailable. Please try again later.");
    expect(all.map((p) => p.calls)).toEqual([1, 1, 1]);
    const streamErr = (await collect(chain).catch((e: unknown) => e)) as AIError;
    expect(streamErr.message).toBe(ALL_FREE_UNAVAILABLE);
  });

  it("no online service configured and no local model: the same plain message (no demo text, nothing paid)", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [] });
    expect(((await chain.generateText(req).catch((e: unknown) => e)) as AIError).message).toBe(ALL_FREE_UNAVAILABLE);
    expect(chain.hasOnlineServices).toBe(false);
  });

  it("a service that just failed rests for a while, so the next requests do not hammer it; it is tried again afterwards", async () => {
    let t = 1_000_000;
    const a = fake({ fail: "rate_limited" });
    const b = fake({ text: "b" });
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", a), slot("b", b)], now: () => t });
    await chain.generateText(req);
    await chain.generateText(req);
    await chain.generateText(req);
    expect(a.calls).toBe(1); // asked once, then left alone
    t += 61_000;
    await chain.generateText(req);
    expect(a.calls).toBe(2);
  });

  it("other local errors (a timeout, a missing model) are reported, not hidden behind an online answer", async () => {
    const a = fake({});
    const slow = fake({ fail: "timeout" });
    const chain = new FreeAiChainProvider({ local: slow, slots: [slot("a", a)] });
    expect(((await chain.generateText(req).catch((e: unknown) => e)) as AIError).code).toBe("timeout");
    expect(a.calls).toBe(0);
  });

  it("streaming: falls through only BEFORE the first token; a service that fails mid-reply is not silently replaced", async () => {
    const a = fake({ fail: "unavailable" });
    const b = fake({ text: "partial", midStreamFail: true });
    const c = fake({ text: "never used" });
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", a), slot("b", b), slot("c", c)] });
    const s = chain.streamText(req);
    expect((await s.next()).value).toBe("partial");
    await expect(s.next()).rejects.toMatchObject({ code: "unavailable" });
    expect(c.calls).toBe(0);
  });

  it("a student who leaves (abort) does not trigger calls to the other services", async () => {
    const controller = new AbortController();
    const a: LLMProvider = {
      name: "free-ai",
      model: "x",
      isMock: false,
      generateText: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      streamText: async function* () {
        throw new Error("unused");
      },
    };
    const b = fake({});
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", a), slot("b", b)] });
    await expect(chain.generateText({ ...req, signal: controller.signal })).rejects.toThrow();
    expect(b.calls).toBe(0);
  });

  it("results never say which online service answered", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("groq", fake({ text: "x" }))] });
    const out = await chain.generateText(req);
    expect(JSON.stringify(out)).not.toMatch(/groq|gemini|openrouter/i);
    const { end } = await collect(chain);
    expect(JSON.stringify(end)).not.toMatch(/groq|gemini|openrouter/i);
  });
});

describe("local model LAST: free online services first, the local model only when they cannot answer", () => {
  const last = (local: LLMProvider, slots: FreeSlot[], extra: Partial<ConstructorParameters<typeof FreeAiChainProvider>[0]> = {}) => new FreeAiChainProvider({ local, slots, localPosition: "last", ...extra });

  it("asks the free online service first and never touches the local model while an online service answers", async () => {
    const local = fake({ text: "local" });
    const a = fake({ text: "from a" });
    const chain = last(local, [slot("a", a)]);
    expect((await chain.generateText(req)).text).toBe("from a");
    expect((await collect(chain)).text).toBe("from a");
    expect(local.calls).toBe(0);
    expect(chain.localPosition).toBe("last");
  });

  it("when every online service hits its limit, the local model answers - in order, once each", async () => {
    const order: number[] = [];
    const a = fake({ fail: "rate_limited" });
    const b = fake({ fail: "rate_limited" });
    const local = fake({ text: "local answer" });
    const chain = last(local, [slot("a", a), slot("b", b)], { onAttempt: (i) => order.push(i.slot) });
    const out = await chain.generateText(req);
    expect(out.text).toBe("local answer");
    expect([a.calls, b.calls, local.calls]).toEqual([1, 1, 1]);
    expect(order).toEqual([0, 1, -1]); // a, b, then the local model
    expect((await collect(chain)).text).toBe("local answer"); // and streaming does the same
  });

  it("services that just hit their limit rest, so the next questions go straight to the local model instead of hammering them", async () => {
    let t = 1_000_000;
    const a = fake({ fail: "rate_limited" });
    const local = fake({ text: "local" });
    const chain = last(local, [slot("a", a)], { now: () => t });
    await chain.generateText(req);
    await chain.generateText(req);
    await chain.generateText(req);
    expect(a.calls).toBe(1);
    expect(local.calls).toBe(3);
    t += 61_000;
    await chain.generateText(req); // the rest is over: the online service is asked again
    expect(a.calls).toBe(2);
  });

  it("if the local model is not running either, the student gets the plain message (nothing paid, no demo text)", async () => {
    const chain = last(localDown(), [slot("a", fake({ fail: "rate_limited" }))]);
    expect(((await chain.generateText(req).catch((e: unknown) => e)) as AIError).message).toBe(ALL_FREE_UNAVAILABLE);
    expect(((await collect(chain).catch((e: unknown) => e)) as AIError).message).toBe(ALL_FREE_UNAVAILABLE);
  });

  it("the local model's own errors (a timeout) are reported, and an online reply that already started is not replaced", async () => {
    const slow = fake({ fail: "timeout" });
    const chain = last(slow, [slot("a", fake({ fail: "unavailable" }))]);
    expect(((await chain.generateText(req).catch((e: unknown) => e)) as AIError).code).toBe("timeout");
    const local = fake({ text: "never used" });
    const mid = last(local, [slot("a", fake({ text: "partial", midStreamFail: true }))]);
    const stream = mid.streamText(req);
    expect((await stream.next()).value).toBe("partial");
    await expect(stream.next()).rejects.toMatchObject({ code: "unavailable" });
    expect(local.calls).toBe(0);
  });

  it("with no online service configured it simply uses the local model", async () => {
    const local = fake({ text: "only local" });
    expect((await last(local, []).generateText(req)).text).toBe("only local");
  });

  it("is chosen from configuration: FREE_AI_LOCAL_POSITION=last, default first, anything else rejected", () => {
    const base = { AI_PROVIDER: "free" as const, OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b", OLLAMA_NUM_CTX: 8192, AI_TIMEOUT_MS: 5000 };
    expect((createLLMProvider({ ...base, FREE_AI_LOCAL_POSITION: "last" }) as FreeAiChainProvider).localPosition).toBe("last");
    expect((createLLMProvider(base) as FreeAiChainProvider).localPosition).toBe("first");
    const e = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co" };
    expect(loadEnv({ ...e, FREE_AI_LOCAL_POSITION: "last" }).FREE_AI_LOCAL_POSITION).toBe("last");
    expect(loadEnv(e).FREE_AI_LOCAL_POSITION).toBe("first");
    expect(() => loadEnv({ ...e, FREE_AI_LOCAL_POSITION: "middle" })).toThrow();
  });

  it("the cost report states the order, so nobody is surprised that questions go online first", () => {
    const input = { AI_PROVIDER: "free", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b", GEMINI_API_KEY: GKEY };
    expect(assessAiCost({ ...input, FREE_AI_LOCAL_POSITION: "last" }, {}).execution).toBe("Free online services first; local AI last");
    expect(assessAiCost(input, {}).execution).toBe("Local first; free online services only if it is not running");
  });
});

describe("status for the administrator's AI screen", () => {
  const limits = { perMinute: 30, perDay: 1000, note: "free plan" };
  const named = (label: string, service: string, model: string, p: LLMProvider): FreeSlot => ({ label, service, model, limits, provider: p });

  it("shows the order, which service answered last, how many requests each was asked today, and the free limits", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [named("a", "Service A", "model-a", fake({ fail: "rate_limited" })), named("b", "Service B", "model-b", fake({ text: "ok" }))] });
    await chain.generateText(req);
    await chain.generateText(req);
    const st = await chain.status();
    expect(st).toMatchObject({ mode: "free", localPosition: "first" });
    expect(st.steps.map((x) => [x.order, x.service, x.where])).toEqual([[1, "Local AI (Ollama)", "this_computer"], [2, "Service A", "online"], [3, "Service B", "online"]]);
    expect(st.lastAnswered).toMatchObject({ service: "Service B", model: "model-b" });
    const [local, a, b] = st.steps;
    expect(local).toMatchObject({ state: "not_running", usedToday: 2 });
    expect(a).toMatchObject({ state: "resting", usedToday: 1, lastResult: "rate_limited", limitPerDay: 1000, limitPerMinute: 30 });
    expect(a!.restingSeconds).toBeGreaterThan(0);
    expect(b).toMatchObject({ state: "ready", usedToday: 2, lastResult: "ok" });
  });

  it("lists the local model last when it is configured to go last, and counts reset on a new day", async () => {
    let t = Date.UTC(2026, 9, 6, 12);
    const chain = new FreeAiChainProvider({ local: fake({ text: "x" }), slots: [named("a", "Service A", "model-a", fake({ text: "x" }))], localPosition: "last", now: () => t });
    await chain.generateText(req);
    let st = await chain.status();
    expect(st.steps.map((x) => x.service)).toEqual(["Service A", "Local AI (Ollama)"]);
    expect(st.steps[0]!.usedToday).toBe(1);
    t += 24 * 60 * 60_000;
    st = await chain.status();
    expect(st.steps[0]!.usedToday).toBe(0); // a new UTC day
    expect(st.steps[0]!.lastResult).toBe("ok"); // but the last result is remembered
  });

  it("contains no key, prompt or answer text", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [named("a", "Service A", "model-a", fake({ text: "a secret answer about biology" }))] });
    await chain.generateText({ messages: [{ role: "user", content: "my private question" }] });
    const text = JSON.stringify(await chain.status());
    expect(text).not.toMatch(/secret answer|private question|gsk_|AIza|Bearer/);
  });

  it("never asks the AI anything: reading the status makes no AI request", async () => {
    const online = fake({ text: "x" });
    const chain = new FreeAiChainProvider({ local: fake({ text: "x" }), slots: [named("a", "Service A", "model-a", online)] });
    await chain.status();
    await chain.status();
    expect(online.calls).toBe(0);
  });
});

describe("building the chain from configuration", () => {
  const base = { AI_PROVIDER: "free" as const, OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b", OLLAMA_NUM_CTX: 8192, AI_TIMEOUT_MS: 5000 };

  it("uses only services that have a key, in the configured order", () => {
    const slots = buildFreeSlots({ ...base, FREE_AI_ORDER: "gemini,groq,openrouter", GROQ_API_KEY: KEY, GEMINI_API_KEY: GKEY });
    expect(slots.map((s) => s.label)).toEqual(["gemini", "groq"]);
    expect(buildFreeSlots({ ...base })).toEqual([]); // no keys: no online service at all
  });

  it("defaults to the documented order: groq, openrouter, gemini (the one that may train on free-tier content is last)", () => {
    const slots = buildFreeSlots({ ...base, GROQ_API_KEY: KEY, GEMINI_API_KEY: GKEY, OPENROUTER_API_KEY: "sk-or-v1-TESTTESTTESTTEST", OPENROUTER_MODEL: "lab/m:free" });
    expect(slots.map((s) => s.label)).toEqual(["groq", "openrouter", "gemini"]);
  });

  it("fails at startup, without echoing a key, for an unknown service, a paid model, or OpenRouter without an explicit :free model", () => {
    expect(() => buildFreeSlots({ ...base, FREE_AI_ORDER: "groq,openai" })).toThrow(PolicyViolation);
    expect(() => buildFreeSlots({ ...base, GROQ_API_KEY: KEY, GROQ_MODEL: "gpt-4o" })).toThrow(PolicyViolation);
    expect(() => buildFreeSlots({ ...base, OPENROUTER_API_KEY: "sk-or-v1-TESTTESTTESTTEST" })).toThrow(PolicyViolation);
    expect(() => buildFreeSlots({ ...base, OPENROUTER_API_KEY: "sk-or-v1-TESTTESTTESTTEST", OPENROUTER_MODEL: "lab/paid" })).toThrow(PolicyViolation);
    try {
      buildFreeSlots({ ...base, GROQ_API_KEY: KEY, GROQ_MODEL: "gpt-4o" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });

  it("AI_PROVIDER=free creates the chain (opaque name); ollama and mock behave as before", () => {
    const free = createLLMProvider({ ...base, GROQ_API_KEY: KEY });
    expect(free.name).toBe("free-ai");
    expect(free.isMock).toBe(false);
    expect(createLLMProvider({ ...base, AI_PROVIDER: "ollama" }).name).toBe("ollama");
    expect(createLLMProvider({ ...base, AI_PROVIDER: "mock" }).name).toBe("mock");
  });

  it("the environment accepts 'free' and still rejects paid-provider names", () => {
    const e = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co" };
    expect(loadEnv({ ...e, AI_PROVIDER: "free" }).AI_PROVIDER).toBe("free");
    for (const bad of ["anthropic", "openai", "gemini", "groq", "paid"]) expect(() => loadEnv({ ...e, AI_PROVIDER: bad })).toThrow();
  });
});

describe("cost report in free mode", () => {
  const input = { AI_PROVIDER: "free", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b" };

  it("is SAFE with approved free services, shows names of keys but never their values, and states paid=false", () => {
    const r = assessAiCost({ ...input, GROQ_API_KEY: KEY, GEMINI_API_KEY: GKEY }, { GROQ_API_KEY: KEY, GEMINI_API_KEY: GKEY });
    expect(r).toMatchObject({ result: "SAFE", paid: false, billingRequired: false, potentialAutomaticBilling: false, cloudRequest: true });
    expect(r.freeServices).toEqual(["groq (openai/gpt-oss-20b)", "gemini (gemini-3.5-flash-lite)"]);
    expect(r.freeKeysPresent).toEqual(["GEMINI_API_KEY", "GROQ_API_KEY"]);
    expect(r.paidKeysPresent).toEqual([]);
    const text = formatCostReport(r);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(GKEY);
  });

  it("is BLOCKED for an unapproved model, an unknown service, or a non-local Ollama address", () => {
    expect(assessAiCost({ ...input, GROQ_API_KEY: KEY, GROQ_MODEL: "gpt-4o" }, {}).result).toBe("BLOCKED");
    expect(assessAiCost({ ...input, FREE_AI_ORDER: "openai" }, {}).result).toBe("BLOCKED");
    expect(assessAiCost({ ...input, OLLAMA_BASE_URL: "http://example.com:11434" }, {}).result).toBe("BLOCKED");
    expect(assessAiCost({ ...input, OPENROUTER_API_KEY: "sk-or-v1-TESTTESTTESTTEST", OPENROUTER_MODEL: "lab/paid" }, {}).result).toBe("BLOCKED");
  });

  it("a paid provider's key is still reported as present-and-ignored", () => {
    const r = assessAiCost(input, { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" });
    expect(r.paidKeysPresent).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });
});

describe("keys never reach logs", () => {
  it.each([KEY, GKEY, "sk-or-v1-TESTTESTTESTTESTTEST", "Bearer " + KEY])("scrubMessage redacts %s", (secret) => {
    const out = scrubMessage(`request failed for ${secret} at host`);
    expect(out).not.toContain(secret.replace("Bearer ", ""));
  });
});

/* ------------------------------ end to end through the tutor ------------------------------ */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const parse = (body: string): TutorStreamEvent[] => body.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));

describe("through the real tutor route", () => {
  async function ask(chain: LLMProvider) {
    const tutor = createInMemoryTutorRepository({ [A]: "Alice" });
    const notes = createInMemoryNotesRepository(tutor);
    const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
    const app = await buildApp({ env, db, ai: chain, verifyToken: async (t) => (t === "token" ? { id: A, email: "a@example.com" } : null), tutorRepo: tutor.repo, notesRepo: notes.repo });
    const headers = { authorization: "Bearer token" };
    const conv = (await app.inject({ method: "POST", url: "/api/tutor/conversations", headers, payload: {} })).json().conversation.id;
    const res = await app.inject({ method: "POST", url: `/api/tutor/conversations/${conv}/messages`, headers, payload: { content: "Explain refraction." } });
    return { events: parse(res.body), raw: res.body, stored: tutor.msgs };
  }

  it("with the local model down, a free service answers: stored as a real (not demo) reply, with an opaque model name", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("groq", fake({ fail: "rate_limited" })), slot("gemini", fake({ text: "Refraction is bending of light." }))] });
    const { events, raw, stored } = await ask(chain);
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") return;
    expect(done.message).toMatchObject({ isMock: false, model: "free-online-ai", content: "Refraction is bending of light." });
    expect(raw).not.toMatch(/groq|gemini|openrouter/i);
    expect(stored.at(-1)).toMatchObject({ role: "assistant", model: "free-online-ai" });
  });

  it("with every free service down, the student sees the plain message and nothing is saved as an answer", async () => {
    const chain = new FreeAiChainProvider({ local: localDown(), slots: [slot("a", fake({ fail: "rate_limited" })), slot("b", fake({ fail: "auth" }))] });
    const { events, stored } = await ask(chain);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "error" });
    expect(JSON.stringify(last)).toContain("All free AI services are currently unavailable. Please try again later.");
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });
});
