import { describe, expect, it, vi } from "vitest";
import { aiStatusSchema } from "@copilot/shared";
import { createInMemoryAccessRepository } from "../access/testing/memory.js";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createDisabledLLMProvider } from "../services/ai/index.js";
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

  it("reports the sole Gemini provider as disabled until the model's free-tier eligibility is verified", async () => {
    const get = await make(answering("hello"));
    const body = aiStatusSchema.parse((await get("admin")).json());
    expect(body.mode).toBe("free");
    expect(body.localPosition).toBeNull();
    expect(body.lastAnswered).toBeNull();
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({
      service: "Google Gemini",
      model: "m",
      state: "not_running",
      limitNote: "Free-tier eligibility is unverified; AI startup is blocked. No provider fallback is enabled.",
    });
  });

  it("reports the deployment's explicit AI-disabled mode", async () => {
    const get = await make(createDisabledLLMProvider());
    const body = aiStatusSchema.parse((await get("admin")).json());
    expect(body.mode).toBe("disabled");
    expect(body.steps[0]).toMatchObject({
      service: "AI disabled",
      model: "none",
      where: "disabled",
      state: "not_running",
      limitNote: "AI is disabled for this deployment. No prompts or study content are sent to an AI provider.",
    });
  });

  it("returns a clear unavailable response for AI generation routes when AI is disabled", async () => {
    const access = createInMemoryAccessRepository([
      { id: ADMIN, displayName: "Alice Admin", email: "a@x.co", role: "admin", accessStatus: "active" },
      { id: S1, displayName: "Ravi", email: "r@x.co", role: "student", accessStatus: "active" },
    ]);
    const app = await buildApp({
      env,
      db: { transaction: vi.fn() } as unknown as Database,
      ai: createDisabledLLMProvider(),
      verifyToken: async (t) => tokens[t] ?? null,
      accessRepo: access.repo,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/quiz/generate",
      headers: { authorization: "Bearer s1" },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "unavailable",
      message: "AI is disabled for this deployment. No AI provider was contacted.",
    });
    await app.close();
  });

  it("the public health check still shows only the generic label (no service names)", async () => {
    const access = createInMemoryAccessRepository([]);
    const app = await buildApp({ env, db: { transaction: vi.fn(), execute: vi.fn() } as unknown as Database, ai: answering("x"), verifyToken: async () => null, accessRepo: access.repo });
    const health = (await app.inject({ url: "/api/health" })).body;
    expect(health).toContain("free-ai");
    expect(health).not.toMatch(/gemini|groq|openrouter/i);
  });
});
