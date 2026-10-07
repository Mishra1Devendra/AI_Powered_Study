import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { readinessResponseSchema } from "@copilot/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { Database } from "./db/client.js";
import { buildLoggerOptions, safeError, safeRequest, scrubMessage } from "./logging.js";
import { AIError } from "./services/ai/errors.js";
import { OllamaOrMockProvider } from "./services/ai/mock-fallback.js";
import { MockProvider } from "./services/ai/mock-provider.js";
import { OllamaProvider } from "./services/ai/ollama-provider.js";
import { withTelemetry } from "./services/ai/telemetry.js";
import type { LLMProvider, TextStream } from "./services/ai/types.js";

const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEifQ.c2lnbmF0dXJlLXNpZw";
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

function capture(level = "info") {
  const lines: string[] = [];
  const stream = new Writable({ write: (chunk, _e, cb) => (lines.push(String(chunk)), cb()) });
  const log = pino({ ...buildLoggerOptions("production"), level }, stream);
  return { log, text: () => lines.join(""), records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("logs never become a second copy of private data", () => {
  it("scrubs the values a database error carries (Drizzle appends the query parameters)", () => {
    const msg = `Failed query: insert into public.messages (content) values ($1)\nparams: My private essay about my health,${JWT}`;
    const out = scrubMessage(msg);
    expect(out).toContain("Failed query");
    expect(out).not.toContain("private essay");
    expect(out).not.toContain(JWT);
    expect(out).toContain("params: [omitted]");
  });

  it("removes tokens, bearer credentials, database URLs and key=value secrets from messages", () => {
    const out = scrubMessage(`bad token ${JWT} Authorization: Bearer abc.def.ghi at postgresql://postgres:hunter2@db.example.com:5432/postgres password=hunter2 apikey: sk-123`);
    for (const secret of [JWT, "abc.def.ghi", "hunter2", "sk-123", "db.example.com"]) expect(out).not.toContain(secret);
  });

  it("shortens very long messages", () => {
    expect(scrubMessage("x".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("keeps what an operator needs from a failed query: error class, code, constraint and table - but not 'detail' (it quotes row values)", () => {
    const cause = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint_name: "documents_user_hash_active_key", table_name: "documents", detail: "Key (user_id, content_hash)=(a, SECRET-HASH) already exists." });
    const err = Object.assign(new Error(`Failed query: insert into documents ...\nparams: SECRET-TEXT`), { name: "DrizzleQueryError", cause });
    const out = JSON.stringify(safeError(err));
    expect(out).toContain("DrizzleQueryError");
    expect(out).toContain("23505");
    expect(out).toContain("documents_user_hash_active_key");
    expect(out).toContain('"table":"documents"');
    expect(out).not.toMatch(/SECRET-TEXT|SECRET-HASH|already exists/);
  });

  it("handles non-Error throwables without leaking", () => {
    expect(safeError("plain string")).toMatchObject({ type: "string" });
    expect(safeError(null)).toMatchObject({ type: "object" });
  });

  it("requests are logged by method and PATH only: search words and ids in the query string never reach the log", () => {
    expect(safeRequest({ id: "r1", method: "GET", url: "/api/search?q=my%20diagnosis&x=1" })).toEqual({ id: "r1", method: "GET", path: "/api/search" });
  });

  it("the real logger configuration applies all of it, and redacts credentials headers", () => {
    const { log, text } = capture();
    log.info({ req: { id: "1", method: "POST", url: "/api/tutor/conversations/abc/messages?secret=1", headers: { authorization: `Bearer ${JWT}`, cookie: "sb=1" } } }, "request");
    log.error({ err: Object.assign(new Error(`Failed query: x\nparams: PRIVATE ANSWER ${JWT}`), { name: "DrizzleQueryError" }) }, "boom");
    const out = text();
    expect(out).toContain("/api/tutor/conversations/abc/messages");
    for (const secret of ["secret=1", "PRIVATE ANSWER", JWT, "sb=1"]) expect(out).not.toContain(secret);
  });
});

describe("AI telemetry: timing and outcome, never content, never an extra call", () => {
  const inner = (over: Partial<LLMProvider> = {}): LLMProvider & { calls: number } => {
    let calls = 0;
    const p = {
      name: "ollama" as const,
      model: "llama3.2:3b",
      isMock: false,
      get calls() {
        return calls;
      },
      async generateText() {
        calls++;
        return { text: "SECRET REPLY", provider: "ollama" as const, model: "llama3.2:3b", isMock: false, usage: { inputTokens: 10, outputTokens: 5 } };
      },
      async *streamText(): TextStream {
        calls++;
        yield "SECRET ";
        yield "STREAM";
        return { usage: { inputTokens: 7, outputTokens: 3 } };
      },
      ...over,
    };
    return p as LLMProvider & { calls: number };
  };

  it("records generate calls (duration, ok, tokens) without the prompt or the reply", async () => {
    const { log, records, text } = capture();
    const ai = withTelemetry(inner(), log);
    const out = await ai.generateText({ system: "PRIVATE SYSTEM", messages: [{ role: "user", content: "PRIVATE STUDENT QUESTION" }], json: true });
    expect(out.text).toBe("SECRET REPLY"); // behaves exactly like the wrapped provider
    expect(records()[0]).toMatchObject({ event: "ai_call", op: "generate", provider: "ollama", model: "llama3.2:3b", ok: true, json: true, messages: 1, tokensIn: 10, tokensOut: 5 });
    expect(typeof records()[0]!.ms).toBe("number");
    expect(text()).not.toMatch(/SECRET|PRIVATE/);
  });

  it("records streaming calls with time to first byte", async () => {
    const { log, records, text } = capture();
    const ai = withTelemetry(inner(), log);
    let got = "";
    for await (const chunk of ai.streamText({ messages: [{ role: "user", content: "PRIVATE" }] })) got += chunk;
    expect(got).toBe("SECRET STREAM");
    expect(records()[0]).toMatchObject({ op: "stream", ok: true, tokensOut: 3 });
    expect(records()[0]!.firstByteMs).not.toBeNull();
    expect(text()).not.toMatch(/SECRET|PRIVATE/);
  });

  it("records failures by error CODE (warn), and rethrows the same error", async () => {
    const { log, records } = capture();
    const boom = new AIError("timeout", "The local AI took too long to respond.", true);
    const ai = withTelemetry(inner({ generateText: async () => Promise.reject(boom) }), log);
    await expect(ai.generateText({ messages: [] })).rejects.toBe(boom);
    expect(records()[0]).toMatchObject({ level: 40, ok: false, code: "timeout" });
  });

  it("makes exactly one call per call - no retry, no extra call of its own", async () => {
    const wrapped = inner();
    const ai = withTelemetry(wrapped, capture().log);
    await ai.generateText({ messages: [] });
    for await (const _ of ai.streamText({ messages: [] })) void _;
    expect(wrapped.calls).toBe(2);
    const failing = inner({ generateText: vi.fn(async () => Promise.reject(new AIError("unavailable", "x", true))) });
    await expect(withTelemetry(failing, capture().log).generateText({ messages: [] })).rejects.toThrow();
    expect(failing.generateText).toHaveBeenCalledTimes(1);
  });

  it("labels what the fallback produced (mock vs real) from the stream's own metadata", async () => {
    const { log, records } = capture();
    const down: LLMProvider = {
      name: "ollama",
      model: "llama3.2:3b",
      isMock: false,
      generateText: async () => Promise.reject(new AIError("local_unavailable", "down")),
      // eslint-disable-next-line require-yield
      async *streamText(): TextStream {
        throw new AIError("local_unavailable", "down");
      },
    };
    const ai = withTelemetry(new OllamaOrMockProvider(down, 0), log);
    for await (const _ of ai.streamText({ messages: [{ role: "user", content: "hi" }] })) void _;
    expect(records().at(-1)).toMatchObject({ ok: true, mock: true });
  });
});

describe("AI health probe (lists models; never generates)", () => {
  const provider = (fetchImpl: typeof fetch, model = "llama3.2:3b") => new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model, timeoutMs: 1000, numCtx: 2048, fetchImpl });

  it("reachable + model installed", async () => {
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }] }), { status: 200 }));
    expect(await provider(f as unknown as typeof fetch).probe()).toEqual({ reachable: true, modelInstalled: true });
    expect(String(f.mock.calls[0]![0])).toBe("http://127.0.0.1:11434/api/tags"); // a listing, not /api/chat
  });

  it("reachable but the configured model is missing", async () => {
    const f = async () => new Response(JSON.stringify({ models: [{ name: "other:1b" }] }), { status: 200 });
    expect(await provider(f as unknown as typeof fetch).probe()).toEqual({ reachable: true, modelInstalled: false });
  });

  it("not running -> reachable false (never throws)", async () => {
    const f = async () => Promise.reject(new TypeError("fetch failed"));
    expect(await provider(f as unknown as typeof fetch).probe()).toEqual({ reachable: false, modelInstalled: null });
  });

  it("the fallback provider delegates to Ollama", async () => {
    const f = async () => Promise.reject(new TypeError("fetch failed"));
    expect(await new OllamaOrMockProvider(provider(f as unknown as typeof fetch), 0).probe()).toEqual({ reachable: false, modelInstalled: null });
  });
});

describe("GET /api/health*", () => {
  const verifyToken = async () => null;
  const okDb = { execute: async () => [{ "?column?": 1 }] } as unknown as Database;
  const badDb = { execute: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")) } as unknown as Database;
  const withProbe = (probe: LLMProvider["probe"]): LLMProvider & { generated: number } => {
    const p = { name: "ollama" as const, model: "llama3.2:3b", isMock: false, generated: 0, probe, generateText: async () => ((p.generated += 1), Promise.reject(new Error("must not be called"))), async *streamText(): TextStream { p.generated += 1; throw new Error("must not be called"); } };
    return p as LLMProvider & { generated: number };
  };

  it("liveness is just 'the API is running' - no database or AI work", async () => {
    const ai = withProbe(async () => ({ reachable: true, modelInstalled: true }));
    const app = await buildApp({ env, db: badDb, ai, verifyToken });
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", ai: { provider: "ollama", isMock: false, model: "llama3.2:3b" } });
  });

  it("readiness reports only whether the database answers, and never touches the AI", async () => {
    let probed = 0;
    const ai = withProbe(async () => ((probed += 1), { reachable: true, modelInstalled: true }));
    const app = await buildApp({ env, db: okDb, ai, verifyToken });
    const res = await app.inject({ url: "/api/health/ready" });
    const body = readinessResponseSchema.parse(res.json());
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ status: "ok", database: { ok: true, latencyMs: null, error: null }, ai: { reachable: null, modelInstalled: null } });
    expect(probed).toBe(0);
    expect(ai.generated).toBe(0);
  });

  it("an AI that is down changes nothing here (it falls back to the labelled demo AI; the admin AI-status page reports it)", async () => {
    const ai = withProbe(async () => ({ reachable: false, modelInstalled: null }));
    const res = await (await buildApp({ env, db: okDb, ai, verifyToken })).inject({ url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("the public probes never print the free-AI chain model name", async () => {
    const chain = { ...withProbe(async () => ({ reachable: true, modelInstalled: true })), name: "free-ai" as const };
    const app = await buildApp({ env, db: okDb, ai: chain, verifyToken });
    for (const url of ["/api/health", "/api/health/ready"]) expect((await app.inject({ url })).body).not.toMatch(/llama|3b/i);
  });

  it("a database failure is a 503 'degraded' with a generic reason - no driver text", async () => {
    const res = await (await buildApp({ env, db: badDb, ai: new MockProvider(0), verifyToken })).inject({ url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", database: { ok: false, error: "Database unreachable" } });
    expect(res.body).not.toMatch(/ECONNREFUSED|5432|127\.0\.0\.1/);
  });

  it("the mock provider reports nothing to reach (null)", async () => {
    const res = await (await buildApp({ env, db: okDb, ai: new MockProvider(0), verifyToken })).inject({ url: "/api/health/ready" });
    expect(res.json().ai).toMatchObject({ provider: "mock", isMock: true, reachable: null });
  });
});
