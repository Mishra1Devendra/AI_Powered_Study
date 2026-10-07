import { describe, expect, it } from "vitest";
import { dashboardSchema, planDetailResponseSchema, planListResponseSchema, planOptionsSchema, sessionActionResponseSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryPlannerRepository } from "../planner/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { OllamaOrMockProvider } from "../services/ai/mock-fallback.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { OllamaProvider } from "../services/ai/ollama-provider.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING = "99999999-9999-4999-8999-999999999999";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

/** Monday 2026-10-05, noon UTC. */
const START = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86_400_000;

const goodReply = JSON.stringify({
  summary: "Physics first.",
  subjects: [
    { subject: "Physics", topics: [{ topic: "Kinematics", minutes: 45 }, { topic: "Forces", minutes: 40 }, { topic: "Energy", minutes: 40 }] },
    { subject: "Chemistry", topics: [{ topic: "Atoms", minutes: 40 }, { topic: "Bonding", minutes: 40 }] },
  ],
});

/** Replays scripted replies (one per model call) and counts calls. */
function scripted(replies: string[]) {
  const requests: GenerateTextRequest[] = [];
  const ai: LLMProvider = {
    name: "ollama",
    model: "scripted-model",
    isMock: false,
    async generateText(req) {
      requests.push(req);
      const next = replies.shift();
      if (next === undefined) throw new Error("script exhausted");
      return { text: next, provider: "ollama", model: "scripted-model", isMock: false };
    },
    // eslint-disable-next-line require-yield
    async *streamText(): TextStream {
      throw new Error("not used");
    },
  };
  return { ai, requests };
}

/** Holds generation open until released. */
function gated(inner: LLMProvider) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const ai: LLMProvider = {
    name: inner.name,
    model: inner.model,
    isMock: inner.isMock,
    async generateText(req) {
      calls++;
      await gate;
      return inner.generateText(req);
    },
    streamText: (req) => inner.streamText(req),
  };
  return { ai, release, calls: () => calls };
}

async function make(ai: LLMProvider = new MockProvider(0)) {
  const clock = { t: START };
  const now = () => new Date(clock.t);
  const tutorStore = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutorStore);
  const quiz = createInMemoryQuizRepository(notes.repo, now);
  const planner = createInMemoryPlannerRepository(now);
  // The only direct database read left is the dashboard profile lookup.
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({ env, db, ai, verifyToken, tutorRepo: tutorStore.repo, notesRepo: notes.repo, quizRepo: quiz.repo, plannerRepo: planner.repo, plannerNow: now });
  return { app, planner, clock };
}
type Ctx = Awaited<ReturnType<typeof make>>;

const call = (c: Ctx, who: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  c.app.inject({ method, url, headers: bearer(who), ...(payload !== undefined ? { payload: payload as object } : {}) });

const body = (over: Record<string, unknown> = {}) => ({
  title: "Board exams",
  examDate: "2026-11-02",
  targetScore: 85,
  minutesPerDay: 120,
  knowledgeLevel: "intermediate",
  subjects: [
    { name: "Physics", priority: "high", topics: [] },
    { name: "Chemistry", priority: "medium", topics: ["Moles"] },
  ],
  studyDays: [1, 2, 3, 4, 5],
  preferredTime: "evening",
  ...over,
});

async function createPlan(c: Ctx, who = A, over: Record<string, unknown> = {}) {
  const res = await call(c, who, "POST", "/api/study-plans/generate", body(over));
  expect(res.statusCode).toBe(202);
  await c.app.planner.whenIdle();
  return res.json().plan.id as string;
}
const detail = async (c: Ctx, id: string, who = A) => planDetailResponseSchema.parse((await call(c, who, "GET", `/api/study-plans/${id}`)).json());
const act = (c: Ctx, sessionId: string, action: string, payload?: unknown, who = A) => call(c, who, "POST", `/api/study-sessions/${sessionId}/${action}`, payload ?? {});

describe("study planner API: authentication", () => {
  it.each([
    ["GET", "/api/study-plans"],
    ["GET", "/api/study-plans/options"],
    ["POST", "/api/study-plans/generate"],
    ["GET", `/api/study-plans/${MISSING}`],
    ["PATCH", `/api/study-plans/${MISSING}`],
    ["POST", `/api/study-plans/${MISSING}/regenerate`],
    ["POST", `/api/study-plans/${MISSING}/activate`],
    ["POST", `/api/study-sessions/${MISSING}/start`],
  ] as const)("%s %s requires a signed-in student", async (method, url) => {
    const c = await make();
    const res = await c.app.inject({ method, url, payload: {} });
    expect(res.statusCode).toBe(401);
    const bad = await c.app.inject({ method, url, payload: {}, headers: { authorization: "Bearer forged" } });
    expect(bad.statusCode).toBe(401);
  });
});

describe("creating a plan", () => {
  it("returns 202 at once, then the plan becomes active with valid sessions (Mock provider, marked as demo)", async () => {
    const c = await make();
    const res = await call(c, A, "POST", "/api/study-plans/generate", body());
    expect(res.statusCode).toBe(202);
    expect(res.json().plan.status).toBe("generating");
    await c.app.planner.whenIdle();
    const d = await detail(c, res.json().plan.id);
    expect(d.plan).toMatchObject({ status: "active", isMock: true, title: "Board exams", startDate: "2026-10-05", examDate: "2026-11-02", targetScore: 85 });
    expect(d.plan.summary).toContain("[Demo]");
    expect(d.sessions.length).toBeGreaterThan(0);
    expect(d.sessions.every((s) => s.date >= "2026-10-05" && s.date < "2026-11-02" && s.status === "planned")).toBe(true);
    expect(d.plan.stats).toMatchObject({ completed: 0, totalSessions: d.sessions.length });
    expect(d.today).toBe("2026-10-05");
    // Daily limit respected.
    const perDay = new Map<string, number>();
    for (const s of d.sessions) perDay.set(s.date, (perDay.get(s.date) ?? 0) + s.durationMinutes);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(120);
  });

  it("uses the real Ollama path once, and stores the real model", async () => {
    const s = scripted([goodReply]);
    const c = await make(s.ai);
    const id = await createPlan(c);
    expect(s.requests).toHaveLength(1);
    const d = await detail(c, id);
    expect(d.plan).toMatchObject({ status: "active", isMock: false, model: "scripted-model" });
    expect(d.sessions.some((x) => x.topic === "Kinematics")).toBe(true);
    expect(d.sessions.some((x) => x.topic === "Moles")).toBe(true);
  });

  it("falls back to the Mock provider when Ollama is not running", async () => {
    const down = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 1000, numCtx: 8192, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const c = await make(new OllamaOrMockProvider(down, 0));
    const d = await detail(c, await createPlan(c));
    expect(d.plan).toMatchObject({ status: "active", isMock: true });
  });

  it("a malformed AI answer fails the plan with a safe message, saves no sessions and makes no second call", async () => {
    const s = scripted(["{ this is not json"]);
    const c = await make(s.ai);
    const id = await createPlan(c, A, { subjects: [{ name: "Physics", priority: "high", topics: [] }] });
    const d = await detail(c, id);
    expect(d.plan.status).toBe("failed");
    expect(d.plan.error).toContain("could not be read");
    expect(d.sessions).toEqual([]);
    expect(c.planner.sessions).toHaveLength(0);
    expect(s.requests).toHaveLength(1);
  });

  it("prevents a second generation while one is running (one model call only)", async () => {
    const g = gated(new MockProvider(0));
    const c = await make(g.ai);
    const first = await call(c, A, "POST", "/api/study-plans/generate", body());
    expect(first.statusCode).toBe(202);
    const second = await call(c, A, "POST", "/api/study-plans/generate", body());
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "generation_in_progress", planId: first.json().plan.id });
    // While running, the plan reports its real stage.
    const during = await detail(c, first.json().plan.id);
    expect(during.plan.progress?.stage).toBe("analyzing");
    // Another student is not blocked.
    expect((await call(c, B, "POST", "/api/study-plans/generate", body())).statusCode).toBe(202);
    g.release();
    await c.app.planner.whenIdle();
    expect(g.calls()).toBe(2);
    expect((await detail(c, first.json().plan.id)).plan.status).toBe("active");
  });

  it("marks a plan interrupted by a restart as failed (no endless spinner)", async () => {
    const c = await make();
    const stuck = await c.planner.repo.createPlan({ userId: A, title: "Old", examDate: "2026-11-02", startDate: "2026-10-05", targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", studyDays: [1], preferredTime: "any", subjects: [{ name: "Maths", priority: "medium", topics: [] }], weakTopics: [] });
    c.clock.t += 10 * 60_000;
    const d = await detail(c, stuck.id);
    expect(d.plan.status).toBe("failed");
    expect(d.plan.error).toContain("interrupted");
  });

  describe("validation", () => {
    it.each([
      ["an exam date in the past", { examDate: "2026-10-01" }],
      ["an exam date of today", { examDate: "2026-10-05" }],
      ["an exam date too far away", { examDate: "2027-06-01" }],
      ["an impossible exam date", { examDate: "2026-02-30" }],
      ["a malformed exam date", { examDate: "next friday" }],
      ["zero minutes a day", { minutesPerDay: 0 }],
      ["more than 8 hours a day", { minutesPerDay: 600 }],
      ["fractional minutes", { minutesPerDay: 45.5 }],
      ["minutes as text", { minutesPerDay: "lots" }],
      ["no subjects", { subjects: [] }],
      ["an empty subject name", { subjects: [{ name: "   ", priority: "high", topics: [] }] }],
      ["a duplicate subject", { subjects: [{ name: "Physics" }, { name: "physics" }] }],
      ["too many subjects", { subjects: Array.from({ length: 9 }, (_, k) => ({ name: `S${k}` })) }],
      ["an unknown priority", { subjects: [{ name: "Physics", priority: "urgent" }] }],
      ["no study days", { studyDays: [] }],
      ["an invalid weekday", { studyDays: [0, 8] }],
      ["an unknown level", { knowledgeLevel: "genius" }],
      ["an unknown time of day", { preferredTime: "midnight" }],
      ["a target score over 100", { targetScore: 140 }],
      ["an empty title", { title: "" }],
    ])("rejects %s with 400 and calls no AI", async (_label, over) => {
      const s = scripted([goodReply]);
      const c = await make(s.ai);
      const res = await call(c, A, "POST", "/api/study-plans/generate", body(over));
      expect(res.statusCode).toBe(400);
      expect(s.requests).toHaveLength(0);
      expect(c.planner.plans).toHaveLength(0);
    });

    it("rejects study days that never occur before the exam", async () => {
      const c = await make();
      const res = await call(c, A, "POST", "/api/study-plans/generate", body({ examDate: "2026-10-07", studyDays: [5] }));
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("no study days");
    });

    it("never trusts a user id sent by the browser", async () => {
      const c = await make();
      const res = await call(c, A, "POST", "/api/study-plans/generate", { ...body(), userId: B, user_id: B });
      expect(res.statusCode).toBe(202);
      await c.app.planner.whenIdle();
      expect(c.planner.plans[0]!.userId).toBe(A);
      expect(planListResponseSchema.parse((await call(c, B, "GET", "/api/study-plans")).json()).plans).toHaveLength(0);
    });
  });
});

describe("options and listing", () => {
  it("returns today in the student's timezone and real suggestions", async () => {
    const c = await make();
    c.planner.setTimezone(A, "Pacific/Kiritimati");
    c.planner.setSubjects(A, ["Physics"]);
    const o = planOptionsSchema.parse((await call(c, A, "GET", "/api/study-plans/options")).json());
    expect(o).toMatchObject({ today: "2026-10-06", timezone: "Pacific/Kiritimati", subjects: ["Physics"], weakTopics: [] });
  });

  it("lists only the student's own plans with real stats", async () => {
    const c = await make();
    const id = await createPlan(c);
    await createPlan(c, B);
    const list = planListResponseSchema.parse((await call(c, A, "GET", "/api/study-plans")).json());
    expect(list.plans.map((p) => p.id)).toEqual([id]);
    expect(list.activePlanId).toBe(id);
    expect(list.plans[0]!.stats.totalSessions).toBeGreaterThan(0);
  });
});

describe("ownership", () => {
  it("another student's plan and sessions behave as not found", async () => {
    const c = await make();
    const id = await createPlan(c);
    const session = (await detail(c, id)).sessions[0]!;
    expect((await call(c, B, "GET", `/api/study-plans/${id}`)).statusCode).toBe(404);
    expect((await call(c, B, "PATCH", `/api/study-plans/${id}`, { title: "Mine now" })).statusCode).toBe(404);
    expect((await call(c, B, "POST", `/api/study-plans/${id}/regenerate`, {})).statusCode).toBe(404);
    expect((await call(c, B, "POST", `/api/study-plans/${id}/activate`, {})).statusCode).toBe(404);
    for (const action of ["start", "complete", "skip", "miss", "reschedule"]) expect((await act(c, session.id, action, {}, B)).statusCode).toBe(404);
    const after = await detail(c, id);
    expect(after.plan.title).toBe("Board exams");
    expect(after.sessions[0]!.status).toBe("planned");
  });

  it("rejects malformed ids and unknown actions with 400", async () => {
    const c = await make();
    expect((await call(c, A, "GET", "/api/study-plans/not-a-uuid")).statusCode).toBe(400);
    expect((await call(c, A, "GET", "/api/study-plans/1;drop table study_plans")).statusCode).toBe(400);
    expect((await act(c, "nope", "start")).statusCode).toBe(400);
    expect((await act(c, MISSING, "delete")).statusCode).toBe(400);
    expect((await act(c, MISSING, "start")).statusCode).toBe(404);
  });
});

describe("sessions", () => {
  async function withPlan(ai?: LLMProvider) {
    const c = await make(ai);
    const id = await createPlan(c);
    const d = await detail(c, id);
    return { c, id, sessions: d.sessions };
  }

  it("start -> complete records real progress", async () => {
    const { c, id, sessions } = await withPlan();
    const s = sessions[0]!;
    const started = sessionActionResponseSchema.parse((await act(c, s.id, "start")).json());
    expect(started.session).toMatchObject({ status: "in_progress", effectiveStatus: "in_progress" });
    expect(started.session.startedAt).not.toBeNull();
    expect((await act(c, s.id, "start")).statusCode).toBe(409);
    const done = sessionActionResponseSchema.parse((await act(c, s.id, "complete")).json());
    expect(done.session.status).toBe("completed");
    expect(done.session.completedAt).not.toBeNull();
    const d = await detail(c, id);
    expect(d.plan.stats).toMatchObject({ completed: 1, completedMinutes: s.durationMinutes });
    // A completed session cannot be skipped, started or rescheduled.
    for (const action of ["skip", "start", "reschedule", "miss"]) expect((await act(c, s.id, action)).statusCode).toBe(409);
  });

  it("skip works from planned, and a skipped session can be rescheduled", async () => {
    const { c, sessions } = await withPlan();
    const s = sessions[0]!;
    expect(sessionActionResponseSchema.parse((await act(c, s.id, "skip")).json()).session.status).toBe("skipped");
    expect((await act(c, s.id, "complete")).statusCode).toBe(409);
    const moved = sessionActionResponseSchema.parse((await act(c, s.id, "reschedule")).json());
    expect(moved.session.status).toBe("rescheduled");
    expect(moved.created).toMatchObject({ status: "planned", topic: s.topic, rescheduledFromId: s.id });
  });

  it("a past unfinished session shows as missed; 'Keep as missed' stores it, and it cannot be marked missed early", async () => {
    const { c, id, sessions } = await withPlan();
    const s = sessions[0]!;
    expect((await act(c, s.id, "miss")).statusCode).toBe(409);
    c.clock.t += 3 * DAY;
    const d = await detail(c, id);
    const seen = d.sessions.find((x) => x.id === s.id)!;
    expect(seen).toMatchObject({ status: "planned", effectiveStatus: "missed" });
    expect(d.plan.stats.missed).toBeGreaterThan(0);
    const kept = sessionActionResponseSchema.parse((await act(c, s.id, "miss")).json());
    expect(kept.session).toMatchObject({ status: "missed", effectiveStatus: "missed" });
  });

  it("rescheduling a missed session keeps its history, stays before the exam and within the daily time", async () => {
    const { c, id, sessions } = await withPlan();
    const s = sessions[0]!;
    c.clock.t += 2 * DAY; // today = 2026-10-07
    const res = sessionActionResponseSchema.parse((await act(c, s.id, "reschedule")).json());
    expect(res.session).toMatchObject({ id: s.id, status: "rescheduled", rescheduledToId: res.created!.id });
    expect(res.created!.date >= "2026-10-07").toBe(true);
    expect(res.created!.date < "2026-11-02").toBe(true);
    const d = await detail(c, id);
    expect(d.sessions.find((x) => x.id === s.id)).toMatchObject({ status: "rescheduled", rescheduledToId: res.created!.id });
    expect(d.sessions.find((x) => x.id === res.created!.id)).toMatchObject({ status: "planned", rescheduledFromId: s.id });
    const day = d.sessions.filter((x) => x.date === res.created!.date && x.status !== "rescheduled");
    expect(day.reduce((m, x) => m + x.durationMinutes, 0)).toBeLessThanOrEqual(120);
    // The original is history: it cannot be moved again.
    expect((await act(c, s.id, "reschedule")).statusCode).toBe(409);
  });

  it("validates a chosen reschedule date", async () => {
    const { c, sessions } = await withPlan();
    const s = sessions[0]!;
    expect((await act(c, s.id, "reschedule", { date: "2026-10-01" })).statusCode).toBe(400);
    expect((await act(c, s.id, "reschedule", { date: "2026-11-02" })).statusCode).toBe(400);
    expect((await act(c, s.id, "reschedule", { date: "2026-12-25" })).statusCode).toBe(400);
    expect((await act(c, s.id, "reschedule", { date: "2026-13-01" })).statusCode).toBe(400);
    // A full day (two 60-minute sessions already) has no room.
    const full = sessions.find((x) => x.date !== s.date)!.date;
    const res = await act(c, s.id, "reschedule", { date: full });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("120 minutes a day");
    // A free weekend day is fine.
    const ok = sessionActionResponseSchema.parse((await act(c, s.id, "reschedule", { date: "2026-10-10" })).json());
    expect(ok.created!.date).toBe("2026-10-10");
  });

  it("refuses to reschedule when there is no time left before the exam", async () => {
    const c = await make();
    const id = await createPlan(c, A, { examDate: "2026-10-07", studyDays: [1, 2, 3, 4, 5, 6, 7], minutesPerDay: 30 });
    const d = await detail(c, id);
    const res = await act(c, d.sessions[0]!.id, "reschedule");
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("no free time");
  });

  it("sessions of an archived plan cannot be changed", async () => {
    const { c, id, sessions } = await withPlan();
    const res = await call(c, A, "POST", `/api/study-plans/${id}/regenerate`, {});
    expect(res.statusCode).toBe(202);
    await c.app.planner.whenIdle();
    expect((await act(c, sessions[0]!.id, "start")).statusCode).toBe(409);
  });
});

describe("regenerate, activate and edit", () => {
  it("regenerating creates a NEW plan and keeps the old one (archived, with its sessions and progress)", async () => {
    const c = await make();
    const oldId = await createPlan(c);
    const old = await detail(c, oldId);
    await act(c, old.sessions[0]!.id, "complete");
    const res = await call(c, A, "POST", `/api/study-plans/${oldId}/regenerate`, {});
    expect(res.statusCode).toBe(202);
    const newId = res.json().plan.id;
    expect(newId).not.toBe(oldId);
    await c.app.planner.whenIdle();
    const list = planListResponseSchema.parse((await call(c, A, "GET", "/api/study-plans")).json());
    expect(list.activePlanId).toBe(newId);
    expect(list.plans.find((p) => p.id === oldId)).toMatchObject({ status: "archived", stats: { completed: 1 } });
    expect((await detail(c, oldId)).sessions).toHaveLength(old.sessions.length);
  });

  it("a failed regeneration leaves the current plan active", async () => {
    const s = scripted([goodReply, "garbage"]);
    const c = await make(s.ai);
    const oldId = await createPlan(c);
    const res = await call(c, A, "POST", `/api/study-plans/${oldId}/regenerate`, {});
    await c.app.planner.whenIdle();
    expect((await detail(c, res.json().plan.id)).plan.status).toBe("failed");
    expect((await detail(c, oldId)).plan.status).toBe("active");
  });

  it("an archived plan can be made active again (the other is archived, not deleted)", async () => {
    const c = await make();
    const first = await createPlan(c);
    const second = await createPlan(c);
    expect((await detail(c, first)).plan.status).toBe("archived");
    const res = await call(c, A, "POST", `/api/study-plans/${first}/activate`, {});
    expect(res.statusCode).toBe(200);
    expect((await detail(c, first)).plan.status).toBe("active");
    expect((await detail(c, second)).plan.status).toBe("archived");
    expect(c.planner.plans).toHaveLength(2);
  });

  it("edits the name, daily time and exam date", async () => {
    const c = await make();
    const id = await createPlan(c);
    const res = await call(c, A, "PATCH", `/api/study-plans/${id}`, { title: "Finals", minutesPerDay: 90, examDate: "2026-12-01" });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toMatchObject({ title: "Finals", minutesPerDay: 90, examDate: "2026-12-01" });
  });

  it.each([
    ["an empty patch", {}],
    ["an empty title", { title: "  " }],
    ["a past exam date", { examDate: "2026-10-01" }],
    ["an invalid daily time", { minutesPerDay: 5 }],
    ["an impossible date", { examDate: "2026-11-31" }],
  ])("rejects %s", async (_label, patch) => {
    const c = await make();
    const id = await createPlan(c);
    expect((await call(c, A, "PATCH", `/api/study-plans/${id}`, patch)).statusCode).toBe(400);
  });

  it("will not move the exam before planned sessions", async () => {
    const c = await make();
    const id = await createPlan(c);
    const res = await call(c, A, "PATCH", `/api/study-plans/${id}`, { examDate: "2026-10-10" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sessions_after_exam");
    expect((await detail(c, id)).plan.examDate).toBe("2026-11-02");
  });
});

describe("dashboard integration", () => {
  it("shows today's real sessions from the active plan, and nothing without a plan", async () => {
    const c = await make();
    const empty = dashboardSchema.parse((await call(c, A, "GET", "/api/dashboard")).json());
    expect(empty.plan).toEqual([]);
    expect(empty.today.tasksPlanned).toBeNull();
    const id = await createPlan(c);
    const today = (await detail(c, id)).sessions.filter((s) => s.date === "2026-10-05");
    await act(c, today[0]!.id, "complete");
    const d = dashboardSchema.parse((await call(c, A, "GET", "/api/dashboard")).json());
    expect(d.plan.map((p) => p.id)).toEqual(today.map((s) => s.id));
    expect(d.plan[0]).toMatchObject({ status: "done", href: `/study-plan?session=${today[0]!.id}` });
    expect(d.today).toMatchObject({ tasksPlanned: today.length, tasksCompleted: 1, plannedMinutes: today.reduce((m, s) => m + s.durationMinutes, 0) });
    // Another student sees none of it.
    expect(dashboardSchema.parse((await call(c, B, "GET", "/api/dashboard")).json()).plan).toEqual([]);
  });
});
