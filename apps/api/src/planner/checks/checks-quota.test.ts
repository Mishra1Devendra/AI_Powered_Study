import { describe, expect, it } from "vitest";
import { SESSION_CHECK_MAX_PER_DAY, planDetailResponseSchema } from "@copilot/shared";
import { createInMemoryAccessRepository } from "../../access/testing/memory.js";
import { createInMemoryAiUsageRepository } from "../../ai-quota/repository.js";
import { buildApp } from "../../app.js";
import { loadEnv } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { createInMemoryNotesRepository } from "../../notes/testing/memory.js";
import { createInMemoryQuizRepository } from "../../quiz/testing/memory.js";
import { MockProvider } from "../../services/ai/mock-provider.js";
import { createInMemoryTutorRepository } from "../../tutor/testing.js";
import { createInMemoryPlannerRepository } from "../testing/memory.js";
import { createInMemoryCheckRepository } from "./memory.js";

/** The daily AI allowance on the study check: only a NEW question set costs a use, and administrators have no limits at all. */
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START = Date.UTC(2026, 9, 5, 12, 0, 0);

async function make(role: "student" | "admin", dailyUnits: number) {
  const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test", AI_DAILY_UNITS: String(dailyUnits) });
  const clock = { t: START };
  const now = () => new Date(clock.t);
  const tutorStore = createInMemoryTutorRepository({ [U]: "Alice" });
  const notes = createInMemoryNotesRepository(tutorStore);
  const quiz = createInMemoryQuizRepository(notes.repo, now);
  const planner = createInMemoryPlannerRepository(now);
  const checkMem = createInMemoryCheckRepository(now);
  const usage = createInMemoryAiUsageRepository();
  const access = createInMemoryAccessRepository([{ id: U, displayName: "Alice", email: "a@x.co", role, accessStatus: "active" }]);
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({
    env,
    db,
    ai: new MockProvider(0),
    verifyToken: async (t) => (t === "tok" ? { id: U, email: "a@x.co" } : null),
    tutorRepo: tutorStore.repo,
    notesRepo: notes.repo,
    quizRepo: quiz.repo,
    plannerRepo: planner.repo,
    plannerNow: now,
    checkRepo: checkMem.repo,
    checkNow: now,
    accessRepo: access.repo,
    aiUsageRepo: usage.repo,
    aiQuotaNow: now,
  });
  let n = 0;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `10.6.0.${++n}`, headers: { authorization: "Bearer tok" }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const gen = await call("POST", "/api/study-plans/generate", { title: "Board exams", examDate: "2026-11-02", targetScore: 85, minutesPerDay: 120, knowledgeLevel: "intermediate", subjects: [{ name: "Physics", priority: "high", topics: [] }], studyDays: [1, 2, 3, 4, 5], preferredTime: "evening" });
  await app.planner.whenIdle();
  const detail = planDetailResponseSchema.parse((await call("GET", `/api/study-plans/${gen.json().plan.id}`)).json());
  const spent = () => [...usage.counters.values()].reduce((a, b) => a + b, 0);
  return { app, call, checkMem, clock, sid: detail.sessions[0]!.id, spent, genStatus: gen.statusCode };
}

describe("study check and the daily AI allowance", () => {
  it("a student pays one use for a new question set, and nothing for getting the same set again", async () => {
    const c = await make("student", 10);
    expect(c.spent()).toBe(2); // the study plan
    expect((await c.call("POST", `/api/study-sessions/${c.sid}/check`)).statusCode).toBe(202);
    expect(c.spent()).toBe(3);
    // a double click / reload while it is being written, and again once it is ready: the same set, no new AI call, no charge
    // (the demo AI answers instantly, so this may already be the finished set: 200 instead of 202)
    expect([200, 202]).toContain((await c.call("POST", `/api/study-sessions/${c.sid}/check`)).statusCode);
    expect(c.spent()).toBe(3);
    await c.app.checks!.whenIdle();
    expect((await c.call("POST", `/api/study-sessions/${c.sid}/check`)).statusCode).toBe(200);
    expect(c.spent()).toBe(3);
  });

  it("a student who is out of uses cannot start a set, and the refusal costs nothing", async () => {
    const c = await make("student", 2); // the plan used both
    const res = await c.call("POST", `/api/study-sessions/${c.sid}/check`);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("ai_limit_reached");
    expect(c.spent()).toBe(2);
    expect(c.checkMem.rows).toHaveLength(0);
  });

  it("an administrator has no per-session cap and no daily limit", async () => {
    const c = await make("admin", 1);
    expect(c.spent()).toBe(0);
    for (let i = 0; i < SESSION_CHECK_MAX_PER_DAY + 3; i++) {
      const started = await c.call("POST", `/api/study-sessions/${c.sid}/check`);
      expect(started.statusCode, `set ${i + 1}`).toBe(202);
      await c.app.checks!.whenIdle();
      const rec = c.checkMem.rows.find((r) => r.id === started.json().check.id)!;
      // fail it, so the next start creates a new set
      const wrong = rec.questions!.map((q) => ({ questionId: q.id, choice: (q.correctIndex + 1) % q.options.length }));
      expect((await c.call("POST", `/api/study-sessions/${c.sid}/check/${rec.id}/answers`, { answers: wrong })).statusCode).toBe(200);
    }
    expect(c.spent()).toBe(0);
  });
});
