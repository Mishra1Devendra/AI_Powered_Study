import { describe, expect, it, vi } from "vitest";
import { aiUsageSchema } from "@copilot/shared";
import { createInMemoryAccessRepository } from "../access/testing/memory.js";
import { createInMemoryAiUsageRepository } from "../ai-quota/repository.js";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createInMemoryStudyToolsRepository } from "../study-tools/memory.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const S2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const tokens: Record<string, { id: string; email: string }> = { admin: { id: ADMIN, email: "a@x.co" }, s1: { id: S1, email: "r@x.co" }, s2: { id: S2, email: "s@x.co" } };
// A 5-use allowance: a mind map costs 2, so a student can make two and not three.
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test", AI_DAILY_UNITS: "5" });

async function make() {
  const clock = { t: new Date("2026-10-06T09:00:00Z") };
  const usage = createInMemoryAiUsageRepository();
  const access = createInMemoryAccessRepository([
    { id: ADMIN, displayName: "Alice Admin", email: "a@x.co", role: "admin", accessStatus: "active" },
    { id: S1, displayName: "Ravi", email: "r@x.co", role: "student", accessStatus: "active" },
    { id: S2, displayName: "Sam", email: "s@x.co", role: "student", accessStatus: "active" },
  ]);
  const app = await buildApp({
    env,
    db: { transaction: vi.fn(), execute: vi.fn() } as unknown as Database,
    ai: new MockProvider(0),
    verifyToken: async (t) => tokens[t] ?? null,
    accessRepo: access.repo,
    notesRepo: createInMemoryNotesRepository(createInMemoryTutorRepository()).repo,
    studyToolsRepo: createInMemoryStudyToolsRepository().repo,
    aiUsageRepo: usage.repo,
    aiQuotaNow: () => new Date(clock.t),
  });
  let n = 0;
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), remoteAddress: `10.5.0.${++n}`, headers: { authorization: `Bearer ${who}` } });
  const map = (who: string, subject = "Cells") => call(who, "POST", "/api/mindmaps/generate", { source: { type: "topic", subject }, size: "small" });
  return { app, call, map, usage, clock };
}

describe("daily AI allowance on the routes", () => {
  it("a student can use the AI until the allowance is spent, then gets a clear 429 - and everything else still works", async () => {
    const { app, call, map } = await make();
    expect((await map("s1")).statusCode).toBe(202);
    await app.studyTools!.idle();
    expect((await map("s1", "Atoms")).statusCode).toBe(202);
    await app.studyTools!.idle();
    const refused = await map("s1", "Forces");
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "ai_limit_reached", limit: 5, used: 4, remaining: 1 });
    expect(refused.json().message).toMatch(/reached today's AI limit.*Mind map needs 2 uses, you have 1 left of 5/);
    // Reading and non-AI actions are never blocked.
    expect((await call("s1", "GET", "/api/mindmaps")).statusCode).toBe(200);
    expect((await call("s1", "POST", "/api/flashcards/decks", { title: "By hand" })).statusCode).toBe(201);
  });

  it("an administrator is never limited", async () => {
    const { app, call, map, usage } = await make();
    for (let i = 0; i < 12; i++) {
      expect((await map("admin", `Topic ${i}`)).statusCode, `request ${i}`).toBe(202);
      await app.studyTools!.idle();
    }
    expect(usage.counters.size).toBe(0);
    expect((await call("admin", "GET", "/api/me/ai-usage")).json()).toMatchObject({ unlimited: true, limit: null, remaining: null });
  });

  it("one student's use does not touch another's", async () => {
    const { app, map } = await make();
    for (let i = 0; i < 2; i++) {
      await map("s1", `T${i}`);
      await app.studyTools!.idle();
    }
    expect((await map("s1", "More")).statusCode).toBe(429);
    expect((await map("s2")).statusCode).toBe(202);
    await app.studyTools!.idle();
  });

  it("a request that fails before using the AI is not charged", async () => {
    const { call, usage } = await make();
    expect((await call("s1", "POST", "/api/mindmaps/generate", { source: { type: "topic", subject: "" }, size: "small" })).statusCode).toBe(400);
    expect((await call("s1", "POST", "/api/mindmaps/generate", { source: { type: "notes", documentIds: ["c1111111-1111-4111-8111-111111111111"] }, size: "small" })).statusCode).toBe(404);
    expect([...usage.counters.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("reports what is left, and the allowance starts again the next day", async () => {
    const { app, call, map, clock } = await make();
    expect(aiUsageSchema.parse((await call("s1", "GET", "/api/me/ai-usage")).json())).toEqual({ unlimited: false, limit: 5, used: 0, remaining: 5, resetsAt: "2026-10-07T00:00:00.000Z" });
    await map("s1");
    await app.studyTools!.idle();
    expect((await call("s1", "GET", "/api/me/ai-usage")).json()).toMatchObject({ used: 2, remaining: 3 });
    // asking does not cost anything
    expect((await call("s1", "GET", "/api/me/ai-usage")).json()).toMatchObject({ used: 2 });
    await map("s1", "Two");
    await app.studyTools!.idle();
    expect((await map("s1", "Three")).statusCode).toBe(429);
    clock.t = new Date("2026-10-07T00:00:05Z");
    expect((await call("s1", "GET", "/api/me/ai-usage")).json()).toMatchObject({ used: 0, remaining: 5 });
    expect((await map("s1", "Three")).statusCode).toBe(202);
    await app.studyTools!.idle();
  });

  it("the usage endpoint needs a sign-in", async () => {
    const { app } = await make();
    expect((await app.inject({ url: "/api/me/ai-usage" })).statusCode).toBe(401);
  });
});
