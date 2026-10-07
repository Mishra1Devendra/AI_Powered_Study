import { describe, expect, it } from "vitest";
import { dashboardSchema, progressResponseSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryProgressRepository } from "../progress/testing/memory.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { GenerateTextRequest, LLMProvider } from "../services/ai/types.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryPlannerRepository } from "../planner/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

/** Thursday 15 October 2026, 12:00 UTC. */
const NOW = new Date(Date.UTC(2026, 9, 15, 12));
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 9, day, hour));

/** A provider that fails the test if anything ever asks it for text: analytics must never call an AI. */
function forbidden() {
  const requests: GenerateTextRequest[] = [];
  const base = new MockProvider(0);
  const ai: LLMProvider = {
    name: base.name,
    model: base.model,
    isMock: true,
    generateText: async (r) => (requests.push(r), base.generateText(r)),
    streamText: (r) => (requests.push(r), base.streamText(r)),
  };
  return { ai, requests };
}

async function make() {
  const tutor = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutor);
  const quiz = createInMemoryQuizRepository(notes.repo);
  const planner = createInMemoryPlannerRepository();
  const progress = createInMemoryProgressRepository();
  const spy = forbidden();
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({ env, db, ai: spy.ai, verifyToken, tutorRepo: tutor.repo, notesRepo: notes.repo, quizRepo: quiz.repo, plannerRepo: planner.repo, progressRepo: progress.repo, progressNow: () => NOW });
  return { app, progress, spy };
}
type Ctx = Awaited<ReturnType<typeof make>>;

const get = (c: Ctx, who: string | null, url: string) => c.app.inject({ method: "GET", url, ...(who ? { headers: bearer(who) } : {}) });
const summary = async (c: Ctx, who: string, range?: string) => {
  const res = await get(c, who, `/api/progress/summary${range ? `?range=${range}` : ""}`);
  expect(res.statusCode).toBe(200);
  return progressResponseSchema.parse(res.json());
};

function seedA(c: Ctx) {
  c.progress.addCompleted(A, at(15, 9), { durationMinutes: 45, subject: "Physics", topic: "Heat", activityType: "learn" });
  c.progress.addCompleted(A, at(14, 9), { durationMinutes: 30, subject: "Maths", topic: "Integration", activityType: "practice" });
  c.progress.addCompleted(A, at(2, 9), { durationMinutes: 60, subject: "Physics", topic: "Waves", activityType: "revision" }); // 13 days ago
  c.progress.addSession(A, { date: "2026-10-13", status: "skipped", updatedAt: at(13, 8) });
  c.progress.addAttempt(A, { title: "Heat quiz", subject: "Physics", submittedAt: at(12), startedAt: at(12, 9), questions: [{ topic: "Heat", result: true }, { topic: "Heat", result: true }, { topic: "Heat", result: false }, { topic: "Heat", result: true }, { topic: "Heat", result: "skipped" }] });
  c.progress.addAttempt(A, { title: "Old quiz", subject: "Physics", submittedAt: at(1), startedAt: at(1, 9), questions: [{ topic: "Waves", result: false }, { topic: "Waves", result: false }, { topic: "Waves", result: true }, { topic: "Waves", result: false }, { topic: "Waves", result: false }] });
  c.progress.addAttempt(A, { title: "Unfinished", status: "in_progress", startedAt: at(14, 9), questions: [{ topic: "Heat", result: true }] });
}

describe("GET /api/progress/summary - security", () => {
  it("rejects a request without a valid token and reads nothing", async () => {
    const c = await make();
    expect((await get(c, null, "/api/progress/summary")).statusCode).toBe(401);
    const forged = await c.app.inject({ method: "GET", url: "/api/progress/summary", headers: { authorization: "Bearer forged" } });
    expect(forged.statusCode).toBe(401);
    expect(c.progress.calls.load).toBe(0);
  });

  it("each student sees only their own numbers", async () => {
    const c = await make();
    seedA(c);
    c.progress.addCompleted(B, at(15, 9), { durationMinutes: 120, subject: "History" });
    const a = await summary(c, A);
    const b = await summary(c, B);
    expect(a.studyTime.totalMinutes).toBe(135);
    expect(a.studyTime.bySubject.map((s) => s.subject)).toEqual(["Physics", "Maths"]);
    expect(b.studyTime.totalMinutes).toBe(120);
    expect(b.studyTime.bySubject).toEqual([{ subject: "History", minutes: 120, sessions: 1 }]);
    expect(b.quiz.attemptsCompleted).toBe(0);
    expect(JSON.stringify(b)).not.toContain("Heat");
  });

  it("ignores any user id sent by the client", async () => {
    const c = await make();
    seedA(c);
    for (const url of [`/api/progress/summary?userId=${A}`, `/api/progress/summary?user_id=${A}&range=30d`]) {
      const res = await c.app.inject({ method: "GET", url, headers: { ...bearer(B), "x-user-id": A } });
      expect(res.statusCode).toBe(200);
      expect(progressResponseSchema.parse(res.json()).studyTime.totalMinutes).toBe(0);
    }
  });

  it.each(["1d", "365d", "all;drop table", "", "30"])("rejects the range %j with 400", async (range) => {
    const c = await make();
    const res = await get(c, A, `/api/progress/summary?range=${encodeURIComponent(range)}`);
    expect(res.statusCode).toBe(400);
    expect(c.progress.calls.load).toBe(0);
  });

  it("answers with ONE read of the database and never calls an AI", async () => {
    const c = await make();
    seedA(c);
    await summary(c, A);
    expect(c.progress.calls.load).toBe(1);
    expect(c.spy.requests).toHaveLength(0);
  });
});

describe("date ranges", () => {
  it("defaults to 30 days", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A);
    expect(r).toMatchObject({ range: "30d", from: "2026-09-16", to: "2026-10-15", today: "2026-10-15", timezone: "UTC" });
  });
  it("7 days: only the last week counts, and the week before is the comparison", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A, "7d");
    expect(r.studyTime).toMatchObject({ totalMinutes: 75, completedSessions: 2, previousMinutes: 60, granularity: "day" });
    expect(r.studyTime.byPeriod).toHaveLength(7);
    expect(r.quiz).toMatchObject({ attemptsCompleted: 1, averageScore: 60, previousAverageScore: null });
  });
  it("30 days includes the older session and quiz", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A, "30d");
    expect(r.studyTime).toMatchObject({ totalMinutes: 135, completedSessions: 3, previousMinutes: null });
    expect(r.quiz.attemptsCompleted).toBe(2);
    expect(r.studyTime.byPeriod).toHaveLength(30);
  });
  it("90 days uses weekly bars; all time has no start and no comparison", async () => {
    const c = await make();
    seedA(c);
    const ninety = await summary(c, A, "90d");
    expect(ninety.studyTime.granularity).toBe("week");
    expect(ninety.studyTime.byPeriod.length).toBeGreaterThanOrEqual(13);
    const all = await summary(c, A, "all");
    expect(all).toMatchObject({ from: null, studyTime: { totalMinutes: 135, previousMinutes: null } });
  });
  it("the streak does not depend on the selected range", async () => {
    const c = await make();
    seedA(c);
    const week = await summary(c, A, "7d");
    const all = await summary(c, A, "all");
    expect(week.streak).toEqual(all.streak);
    expect(week.streak).toMatchObject({ current: 2, longest: 2, studyDays: 3, lastStudyDate: "2026-10-15" });
  });
});

describe("the numbers", () => {
  it("quizzes: finished attempts only, with real accuracy", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A, "30d");
    expect(r.quiz).toMatchObject({ attemptsCompleted: 2, quizzesCompleted: 2, quizzesAttempted: 3, averageScore: 40, highestScore: 60, lowestScore: 20, recentScore: 60, questions: 10, correct: 4, incorrect: 5, unanswered: 1, accuracy: 40 });
    expect(r.quiz.trend.map((t) => t.quizTitle)).toEqual(["Old quiz", "Heat quiz"]);
  });
  it("topics: labels need enough data, and weak areas are real", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A);
    expect(r.topics.find((t) => t.topic === "Waves")).toMatchObject({ accuracy: 20, level: "weak" });
    expect(r.topics.find((t) => t.topic === "Heat")).toMatchObject({ accuracy: 60, level: "needs_practice" });
    expect(r.weakAreas.map((t) => t.topic)).toEqual(["Waves"]);
    expect(r.improvementComparable).toBe(false);
  });
  it("recent activity: real events, newest first, no unfinished attempts", async () => {
    const c = await make();
    seedA(c);
    const r = await summary(c, A);
    expect(r.activity.map((e) => e.type)).toEqual(["session_completed", "session_completed", "session_skipped", "quiz_completed", "session_completed", "quiz_completed"]);
    expect(r.activity.some((e) => e.title.includes("Unfinished"))).toBe(false);
  });
  it("uses the student's own timezone for the day an activity belongs to", async () => {
    const c = await make();
    c.progress.setTimezone(A, "Asia/Kolkata");
    // 20:00 UTC on the 14th is already the 15th in India (UTC+5:30): the same day as "now" there.
    c.progress.addCompleted(A, new Date(Date.UTC(2026, 9, 14, 20)), { durationMinutes: 30 });
    c.progress.addCompleted(A, new Date(Date.UTC(2026, 9, 14, 12)), { durationMinutes: 30 });
    const r = await summary(c, A, "7d");
    expect(r.timezone).toBe("Asia/Kolkata");
    expect(r.today).toBe("2026-10-15");
    expect(r.streak).toMatchObject({ current: 2, lastStudyDate: "2026-10-15" });
    expect(r.studyTime.byPeriod.find((p) => p.start === "2026-10-15")!.minutes).toBe(30);
    expect(r.studyTime.byPeriod.find((p) => p.start === "2026-10-14")!.minutes).toBe(30);
  });
  it("an unknown timezone falls back to UTC instead of failing", async () => {
    const c = await make();
    c.progress.setTimezone(A, "Not/AZone");
    expect((await summary(c, A)).timezone).toBe("UTC");
  });
});

describe("no data: no made-up numbers", () => {
  it("a student with nothing recorded gets nulls and empty lists, never zeros-as-results", async () => {
    const c = await make();
    const r = await summary(c, A, "all");
    expect(r.studyTime).toMatchObject({ totalMinutes: 0, completionRate: null, averageMinutesPerActiveDay: null, previousMinutes: null, byPeriod: [], bySubject: [], byActivity: [] });
    expect(r.streak).toEqual({ current: null, longest: null, studyDays: 0, lastStudyDate: null });
    expect(r.quiz).toMatchObject({ attemptsCompleted: 0, averageScore: null, highestScore: null, lowestScore: null, recentScore: null, accuracy: null, trend: [] });
    expect(r).toMatchObject({ subjects: [], topics: [], weakAreas: [], improving: [], activity: [], improvementComparable: false, topicSummary: { studied: 0, withEnoughData: 0, strong: 0, needsPractice: 0, weak: 0 } });
  });
  it("planned-only and in-progress quizzes are not progress", async () => {
    const c = await make();
    c.progress.addSession(A, { date: "2026-10-20", status: "planned" });
    c.progress.addAttempt(A, { status: "in_progress", startedAt: at(14), questions: [{ result: true }] });
    const r = await summary(c, A);
    expect(r.studyTime).toMatchObject({ totalMinutes: 0, completedSessions: 0, upcomingSessions: 1, completionRate: null });
    expect(r.quiz).toMatchObject({ attemptsCompleted: 0, averageScore: null, quizzesAttempted: 1 });
    expect(r.streak.current).toBeNull();
  });
});

describe("dashboard snapshot", () => {
  it("shows real study minutes, streak, and weak topics - and nothing without data", async () => {
    const c = await make();
    const empty = dashboardSchema.parse((await get(c, A, "/api/dashboard")).json());
    expect(empty.progress).toMatchObject({ studyMinutes: 0, averageScore: null, currentStreak: null, weakTopic: null });
    expect(empty.today).toMatchObject({ studyMinutes: null, streakDays: null });
    expect(empty.weakTopics).toEqual([]);

    seedA(c);
    const d = dashboardSchema.parse((await get(c, A, "/api/dashboard")).json());
    expect(d.progress).toMatchObject({ studyMinutes: 135, studiedToday: 45, averageScore: 40, attemptsCompleted: 2, currentStreak: 2, weakTopic: { topic: "Waves", accuracy: 20, total: 5 } });
    expect(d.today).toMatchObject({ studyMinutes: 45, streakDays: 2 });
    expect(d.weakTopics[0]).toMatchObject({ topic: "Waves", accuracyPercent: 20, status: "needs_attention", href: "/progress" });
    const other = dashboardSchema.parse((await get(c, B, "/api/dashboard")).json());
    expect(other.progress?.studyMinutes).toBe(0);
  });
});

describe("viva results (kept apart from quizzes)", () => {
  it("shows viva numbers in their own section and never changes the quiz numbers", async () => {
    const c = await make();
    seedA(c);
    const quizBefore = (await summary(c, A, "30d")).quiz;
    c.progress.addViva(A, { subject: "Chemistry", topic: "Rates", score: 70, completedAt: at(14, 9), dims: [8, 6, 7, 5] });
    c.progress.addViva(A, { subject: "Chemistry", topic: "Rates", score: 90, completedAt: at(15, 8), dims: [9, 9, 9, 9] });
    c.progress.addViva(A, { subject: "Physics", score: 40, completedAt: at(2, 9), dims: [4, 4, 4, 4] });
    c.progress.addViva(A, { status: "abandoned", score: 100, completedAt: at(15, 7) }); // never counted
    c.progress.addViva(A, { status: "in_progress", score: 100, completedAt: at(15, 6) });
    const r = await summary(c, A, "30d");
    expect(r.quiz).toEqual(quizBefore);
    expect(r.viva).toMatchObject({ sessionsCompleted: 3, averageScore: 66.7, bestScore: 90, recentScore: 90 });
    expect(r.viva.bySubject).toEqual([
      { subject: "Chemistry", sessions: 2, averageScore: 80 },
      { subject: "Physics", sessions: 1, averageScore: 40 },
    ]);
    expect(r.viva.recent.map((v) => v.score)).toEqual([90, 70, 40]);
    // Quiz topics are untouched by viva topics.
    expect(r.topics.map((t) => t.topic).sort()).toEqual(["Heat", "Waves"]);
  });

  it("follows the selected range, and is empty (nulls) for a student with no viva", async () => {
    const c = await make();
    c.progress.addViva(A, { score: 80, completedAt: at(14, 9) });
    c.progress.addViva(A, { score: 50, completedAt: at(1, 9) });
    expect((await summary(c, A, "7d")).viva.sessionsCompleted).toBe(1);
    expect((await summary(c, A, "all")).viva.sessionsCompleted).toBe(2);
    const none = await summary(c, B, "all");
    expect(none.viva).toEqual({ sessionsCompleted: 0, averageScore: null, bestScore: null, recentScore: null, dimensions: null, bySubject: [], recent: [] });
  });

  it("each student sees only their own vivas", async () => {
    const c = await make();
    c.progress.addViva(A, { subject: "Chemistry", score: 80, completedAt: at(14, 9) });
    c.progress.addViva(B, { subject: "History", score: 60, completedAt: at(14, 9) });
    expect((await summary(c, A)).viva.bySubject.map((s) => s.subject)).toEqual(["Chemistry"]);
    expect((await summary(c, B)).viva.bySubject.map((s) => s.subject)).toEqual(["History"]);
  });

  it("the dashboard card gets the latest completed viva (any time), and nothing when there is none", async () => {
    const c = await make();
    expect(dashboardSchema.parse((await get(c, A, "/api/dashboard")).json()).progress?.viva).toBeNull();
    c.progress.addViva(A, { subject: "Chemistry", topic: "Rates", score: 78, completedAt: at(1, 9) }); // older than 30 days is fine: "last score"
    c.progress.addViva(A, { subject: "Physics", score: 55, completedAt: at(14, 9) });
    c.progress.addViva(A, { status: "abandoned", score: 99, completedAt: at(15, 9) });
    expect(dashboardSchema.parse((await get(c, A, "/api/dashboard")).json()).progress?.viva).toEqual({ lastScore: 55, subject: "Physics", topic: null, completedCount: 2 });
    expect(dashboardSchema.parse((await get(c, B, "/api/dashboard")).json()).progress?.viva).toBeNull();
  });
});
