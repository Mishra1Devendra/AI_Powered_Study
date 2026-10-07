import { describe, expect, it } from "vitest";
import { CHECK_REQUIRED_CODE, SESSION_CHECK_MAX_PER_DAY, SESSION_CHECK_PASS, SESSION_CHECK_QUESTIONS, planDetailResponseSchema, sessionCheckSchema, submitCheckResponseSchema } from "@copilot/shared";
import { buildApp } from "../../app.js";
import { loadEnv } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { createInMemoryNotesRepository } from "../../notes/testing/memory.js";
import { createInMemoryQuizRepository } from "../../quiz/testing/memory.js";
import { MockProvider } from "../../services/ai/mock-provider.js";
import { createInMemoryTutorRepository } from "../../tutor/testing.js";
import { createInMemoryPlannerRepository } from "../testing/memory.js";
import { createInMemoryCheckRepository } from "./memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const START = Date.UTC(2026, 9, 5, 12, 0, 0);

async function make() {
  const clock = { t: START };
  const now = () => new Date(clock.t);
  const tutorStore = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutorStore);
  const quiz = createInMemoryQuizRepository(notes.repo, now);
  const planner = createInMemoryPlannerRepository(now);
  const checkMem = createInMemoryCheckRepository(now);
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({ env, db, ai: new MockProvider(0), verifyToken, tutorRepo: tutorStore.repo, notesRepo: notes.repo, quizRepo: quiz.repo, plannerRepo: planner.repo, plannerNow: now, checkRepo: checkMem.repo, checkNow: now });
  let n = 0;
  const call = (who: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `10.3.0.${++n}`, headers: bearer(who), ...(payload !== undefined ? { payload: payload as object } : {}) });
  // A plan with sessions, owned by A.
  const gen = await call(A, "POST", "/api/study-plans/generate", { title: "Board exams", examDate: "2026-11-02", targetScore: 85, minutesPerDay: 120, knowledgeLevel: "intermediate", subjects: [{ name: "Physics", priority: "high", topics: [] }], studyDays: [1, 2, 3, 4, 5], preferredTime: "evening" });
  await app.planner.whenIdle();
  const detail = planDetailResponseSchema.parse((await call(A, "GET", `/api/study-plans/${gen.json().plan.id}`)).json());
  return { app, call, checkMem, clock, sessions: detail.sessions, planId: gen.json().plan.id as string };
}
type Ctx = Awaited<ReturnType<typeof make>>;

const start = (c: Ctx, sid: string, who = A) => c.call(who, "POST", `/api/study-sessions/${sid}/check`);
const latest = (c: Ctx, sid: string, who = A) => c.call(who, "GET", `/api/study-sessions/${sid}/check`);
const sessionStatus = async (c: Ctx, sid: string) => planDetailResponseSchema.parse((await c.call(A, "GET", `/api/study-plans/${c.planId}`)).json()).sessions.find((s) => s.id === sid)!.status;

/** Answers built from the stored key: `right` of the questions correct, the rest deliberately wrong. */
function answers(c: Ctx, checkId: string, right: number) {
  const rec = c.checkMem.rows.find((r) => r.id === checkId)!;
  return rec.questions!.map((q, i) => ({ questionId: q.id, choice: i < right ? q.correctIndex : (q.correctIndex + 1) % q.options.length }));
}
const submit = (c: Ctx, sid: string, checkId: string, payload: unknown, who = A) => c.call(who, "POST", `/api/study-sessions/${sid}/check/${checkId}/answers`, payload);

describe("study check: starting", () => {
  it("returns 202 while the questions are written, then 5 questions with NO answer key", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const res = await start(c, sid);
    expect(res.statusCode).toBe(202);
    expect(sessionCheckSchema.parse(res.json().check)).toMatchObject({ status: "generating", questions: null, review: null, total: SESSION_CHECK_QUESTIONS, passMark: SESSION_CHECK_PASS });
    await c.app.checks!.whenIdle();
    const ready = sessionCheckSchema.parse((await latest(c, sid)).json().check);
    expect(ready.status).toBe("ready");
    expect(ready.isMock).toBe(true); // the labelled demo AI wrote them
    expect(ready.questions).toHaveLength(SESSION_CHECK_QUESTIONS);
    expect(ready.review).toBeNull();
    const raw = JSON.stringify((await latest(c, sid)).json());
    expect(raw).not.toMatch(/correctIndex|correctAnswer|explanation/); // the key stays on the server
  });

  it("a double click or reload never starts a second set (and so never a second AI call)", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const [a, b] = await Promise.all([start(c, sid), start(c, sid)]);
    expect(a.json().check.id).toBe(b.json().check.id);
    await c.app.checks!.whenIdle();
    const again = await start(c, sid);
    expect(again.statusCode).toBe(200);
    expect(again.json().check.status).toBe("ready");
    expect(c.checkMem.rows).toHaveLength(1);
  });

  it("is refused for a session that is not open, and for someone else's session", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    expect((await c.call(A, "POST", `/api/study-sessions/${sid}/skip`, {})).statusCode).toBe(200);
    const skipped = await start(c, sid);
    expect(skipped.statusCode).toBe(409);
    const other = c.sessions[1]!.id;
    expect((await start(c, other, B)).statusCode).toBe(404);
    expect((await latest(c, other, B)).statusCode === 200 ? (await latest(c, other, B)).json().check : null).toBeNull(); // B sees nothing of A's
    expect(c.checkMem.rows.filter((r) => r.userId === B)).toHaveLength(0);
  });

  it("needs a signed-in student", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    for (const [method, url] of [
      ["POST", `/api/study-sessions/${sid}/check`],
      ["GET", `/api/study-sessions/${sid}/check`],
      ["POST", `/api/study-sessions/${sid}/check/${sid}/answers`],
    ] as const) expect((await c.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
  });
});

describe("study check: the gate on 'mark complete'", () => {
  it("a session cannot be completed directly any more: 409 check_required, and nothing changes", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const res = await c.call(A, "POST", `/api/study-sessions/${sid}/complete`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(CHECK_REQUIRED_CODE);
    expect(await sessionStatus(c, sid)).toBe("planned");
  });

  it("an unfinished or failed check does not unlock it either", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const check = (await start(c, sid)).json().check;
    await c.app.checks!.whenIdle();
    await submit(c, sid, check.id, { answers: answers(c, check.id, 0) });
    expect((await c.call(A, "POST", `/api/study-sessions/${sid}/complete`, {})).statusCode).toBe(409);
    expect(await sessionStatus(c, sid)).toBe("planned");
  });
});

describe("study check: submitting answers", () => {
  async function ready(c: Ctx, sid: string) {
    const check = (await start(c, sid)).json().check;
    await c.app.checks!.whenIdle();
    return check.id as string;
  }

  it(`passing (${SESSION_CHECK_PASS} of ${SESSION_CHECK_QUESTIONS}) completes the session and reveals the review`, async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const id = await ready(c, sid);
    const res = await submit(c, sid, id, { answers: answers(c, id, SESSION_CHECK_PASS) });
    expect(res.statusCode).toBe(200);
    const out = submitCheckResponseSchema.parse(res.json());
    expect(out.check).toMatchObject({ status: "passed", passed: true, score: SESSION_CHECK_PASS });
    expect(out.check.review).toHaveLength(SESSION_CHECK_QUESTIONS);
    expect(out.session).toMatchObject({ id: sid, status: "completed" });
    expect(await sessionStatus(c, sid)).toBe("completed");
  });

  it("failing keeps the session open; a fresh set (different questions) can be started and passed", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const first = await ready(c, sid);
    const failed = submitCheckResponseSchema.parse((await submit(c, sid, first, { answers: answers(c, first, SESSION_CHECK_PASS - 1) })).json());
    expect(failed.check).toMatchObject({ status: "failed", passed: false, score: SESSION_CHECK_PASS - 1 });
    expect(failed.session).toBeNull();
    expect(await sessionStatus(c, sid)).toBe("planned");

    const second = (await start(c, sid)).json().check;
    expect(second.id).not.toBe(first);
    await c.app.checks!.whenIdle();
    const passed = submitCheckResponseSchema.parse((await submit(c, sid, second.id, { answers: answers(c, second.id, SESSION_CHECK_QUESTIONS) })).json());
    expect(passed.check.score).toBe(SESSION_CHECK_QUESTIONS);
    expect(await sessionStatus(c, sid)).toBe("completed");
  });

  it("answers can be submitted only once: a replay (even a better one) is refused", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const id = await ready(c, sid);
    await submit(c, sid, id, { answers: answers(c, id, 0) });
    const replay = await submit(c, sid, id, { answers: answers(c, id, SESSION_CHECK_QUESTIONS) });
    expect(replay.statusCode).toBe(409);
    expect(await sessionStatus(c, sid)).toBe("planned");
  });

  it("rejects malformed answers without grading anything", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const id = await ready(c, sid);
    const good = answers(c, id, 5);
    const rec = c.checkMem.rows.find((r) => r.id === id)!;
    const bad: Array<[string, unknown]> = [
      ["no body", {}],
      ["too few answers", { answers: good.slice(0, 4) }],
      ["too many answers", { answers: [...good, good[0]] }],
      ["a repeated question", { answers: [good[0], good[0], good[2], good[3], good[4]] }],
      ["unknown question ids", { answers: good.map((a) => ({ ...a, questionId: "99999999-9999-4999-8999-999999999999" })) }],
      ["a choice that does not exist", { answers: good.map((a, i) => (i === 0 ? { ...a, choice: 5 } : a)) }],
      ["extra fields", { answers: good, score: 5 }],
      ["a client-supplied score or key", { answers: good.map((a) => ({ ...a, correct: true })) }],
    ];
    for (const [label, payload] of bad) {
      const res = await submit(c, sid, id, payload);
      expect(res.statusCode, label).toBe(400);
    }
    expect(rec.status).toBe("ready"); // still answerable
    expect(await sessionStatus(c, sid)).toBe("planned");
  });

  it("another student can neither read, answer nor complete via someone else's check", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const id = await ready(c, sid);
    const res = await submit(c, sid, id, { answers: answers(c, id, 5) }, B);
    expect(res.statusCode).toBe(404);
    expect(await sessionStatus(c, sid)).toBe("planned");
    expect(c.checkMem.rows.find((r) => r.id === id)!.status).toBe("ready");
  });

  it("cannot be submitted while the questions are still being written", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const check = (await start(c, sid)).json().check;
    const res = await submit(c, sid, check.id, { answers: [] });
    expect([400, 409]).toContain(res.statusCode);
    await c.app.checks!.whenIdle();
  });
});

describe("study check: limits", () => {
  it(`allows ${SESSION_CHECK_MAX_PER_DAY} question sets per session per day, then says so calmly`, async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    for (let i = 0; i < SESSION_CHECK_MAX_PER_DAY; i++) {
      const check = (await start(c, sid)).json().check;
      await c.app.checks!.whenIdle();
      expect((await submit(c, sid, check.id, { answers: answers(c, check.id, 0) })).statusCode).toBe(200);
    }
    const over = await start(c, sid);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("too_many_checks");
    // a day later the student may try again
    c.clock.t += 25 * 60 * 60_000;
    expect([200, 202, 409]).toContain((await start(c, sid)).statusCode);
    await c.app.checks!.whenIdle();
  });

  it("a set that was interrupted (no job running) is marked as failed so the student can ask again", async () => {
    const c = await make();
    const sid = c.sessions[0]!.id;
    const rec = await c.checkMem.repo.create(A, sid); // a 'generating' check nobody is working on
    c.clock.t += 4 * 60_000;
    const seen = sessionCheckSchema.parse((await latest(c, sid)).json().check);
    expect(seen).toMatchObject({ id: rec.id, status: "error" });
    expect(seen.error).toMatch(/interrupted/i);
    const again = await start(c, sid);
    expect(again.json().check.id).not.toBe(rec.id);
    await c.app.checks!.whenIdle();
  });
});
