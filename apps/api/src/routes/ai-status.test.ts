import { describe, expect, it, vi } from "vitest";
import { aiStatusSchema } from "@copilot/shared";
import { createInMemoryAccessRepository } from "../access/testing/memory.js";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { AIError } from "../services/ai/errors.js";
import { FreeAiChainProvider } from "../services/ai/free/chain.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { LLMProvider } from "../services/ai/types.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const tokens: Record<string, { id: string; email: string }> = { admin: { id: ADMIN, email: "a@x.co" }, s1: { id: S1, email: "r@x.co" } };
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

const answering = (text: string): LLMProvider => ({
  name: "free-ai",
  model: "m",
  isMock: false,
  generateText: async () => ({ text, provider: "free-ai", model: "free-online-ai", isMock: false }),
  streamText: async function* () {
    yield text;
    return {};
  },
});

async function make(ai: LLMProvider) {
  const access = createInMemoryAccessRepository([
    { id: ADMIN, displayName: "Alice Admin", email: "a@x.co", role: "admin", accessStatus: "active" },
    { id: S1, displayName: "Ravi", email: "r@x.co", role: "student", accessStatus: "active" },
  ]);
  const app = await buildApp({ env, db: { transaction: vi.fn() } as unknown as Database, ai, verifyToken: async (t) => tokens[t] ?? null, accessRepo: access.repo });
  let n = 0;
  return (who: string | null) => app.inject({ url: "/api/admin/ai-status", remoteAddress: `10.1.0.${++n}`, headers: who ? { authorization: `Bearer ${who}` } : {} });
}

describe("GET /api/admin/ai-status", () => {
  it("is for administrators only", async () => {
    const get = await make(new MockProvider(0));
    expect((await get(null)).statusCode).toBe(401);
    expect((await get("s1")).statusCode).toBe(403);
    expect((await get("admin")).statusCode).toBe(200);
  });

  it("shows the chain: services, models, order and free limits - and which one answered last", async () => {
    const chain = new FreeAiChainProvider({
      local: { ...answering("x"), name: "ollama", generateText: async () => Promise.reject(new AIError("local_unavailable", "off")), streamText: async function* () { throw new AIError("local_unavailable", "off"); } },
      slots: [{ label: "g", service: "Google Gemini", model: "gemini-2.5-flash-lite", limits: { perMinute: null, perDay: null, note: "Set per project" }, provider: answering("hello") }],
    });
    await chain.generateText({ messages: [{ role: "user", content: "hi" }] });
    const get = await make(chain);
    const body = aiStatusSchema.parse((await get("admin")).json());
    expect(body.mode).toBe("free");
    expect(body.steps.map((s) => s.service)).toEqual(["Local AI (Ollama)", "Google Gemini"]);
    expect(body.lastAnswered).toMatchObject({ service: "Google Gemini", model: "gemini-2.5-flash-lite" });
    expect(body.steps[1]).toMatchObject({ usedToday: 1, state: "ready", limitNote: "Set per project" });
  });

  it("in demo mode it says so, and shows no online service", async () => {
    const body = aiStatusSchema.parse((await (await make(new MockProvider(0)))("admin")).json());
    expect(body.mode).toBe("mock");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]!.service).toMatch(/Demo/);
  });

  it("the public health check still shows only the generic label (no service names)", async () => {
    const chain = new FreeAiChainProvider({ local: answering("x"), slots: [{ label: "g", service: "Google Gemini", model: "gemini-2.5-flash-lite", provider: answering("y") }] });
    const access = createInMemoryAccessRepository([]);
    const app = await buildApp({ env, db: { transaction: vi.fn(), execute: vi.fn() } as unknown as Database, ai: chain, verifyToken: async () => null, accessRepo: access.repo });
    const health = (await app.inject({ url: "/api/health" })).body;
    expect(health).toContain("free-ai");
    expect(health).not.toMatch(/gemini|groq|openrouter/i);
  });
});
