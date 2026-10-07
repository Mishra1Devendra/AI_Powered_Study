import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { dashboardSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { buildDashboard } from "../dashboard/build-dashboard.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryPlannerRepository } from "../planner/testing/memory.js";
import { createInMemoryProgressRepository } from "../progress/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SUPABASE_URL: "https://example.supabase.co",
  NODE_ENV: "test",
});
const transaction = vi.fn();
const db = { transaction } as unknown as Database;
const verifyToken = async (t: string) => (t === "good" ? { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co" } : null);

describe("buildDashboard", () => {
  it("returns profile (+ tutor activity) as real data; every other section is empty, never invented", () => {
    const d = buildDashboard({ displayName: "Rahul", timezone: "UTC" });
    expect(dashboardSchema.parse(d)).toEqual(d);
    expect(d.profile.displayName).toBe("Rahul");
    expect(Object.values(d.today).every((v) => v === null)).toBe(true);
    expect(d.continueLearning).toBeNull();
    expect([d.plan, d.weakTopics, d.subjects, d.activity].every((a) => a.length === 0)).toBe(true);
  });
});

describe("dashboardSchema safety", () => {
  const base = buildDashboard({ displayName: "x", timezone: "UTC" });
  it.each(["javascript:alert(1)", "https://evil.example", "//evil.example", "data:text/html,x"])("rejects non-internal link %s", (href) => {
    const bad = { ...base, plan: [{ id: "1", subject: "Maths", topic: "Integration", startTime: null, durationMinutes: 30, status: "todo", href }] };
    expect(dashboardSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts in-app links with a query string", () => {
    const ok = { ...base, plan: [{ id: "1", subject: "Maths", topic: "Integration", startTime: "09:00", durationMinutes: 30, status: "todo", href: "/tutor?topic=integration" }] };
    expect(dashboardSchema.safeParse(ok).success).toBe(true);
  });
});

const USER = "11111111-1111-4111-8111-111111111111";
const store = createInMemoryTutorRepository();
const notesStore = createInMemoryNotesRepository(store);
const quizStore = createInMemoryQuizRepository(notesStore.repo);
const plannerStore = createInMemoryPlannerRepository();
const progressStore = createInMemoryProgressRepository();

describe("GET /api/dashboard", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env, db, ai: new MockProvider(), verifyToken, tutorRepo: store.repo, notesRepo: notesStore.repo, quizRepo: quizStore.repo, plannerRepo: plannerStore.repo, progressRepo: progressStore.repo });
  });
  afterAll(() => app.close());
  beforeEach(() => transaction.mockReset());

  it("requires authentication", async () => {
    const res = await app.inject({ url: "/api/dashboard" });
    expect(res.statusCode).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns the signed-in student's dashboard", async () => {
    transaction.mockResolvedValue([{ displayName: "Rahul", timezone: "UTC" }]);
    const res = await app.inject({ url: "/api/dashboard", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(dashboardSchema.parse(res.json()).profile.displayName).toBe("Rahul");
  });

  it("shows the student's own recent tutor conversations as activity, newest first, with in-app links", async () => {
    transaction.mockResolvedValue([{ displayName: "Rahul", timezone: "UTC" }]);
    const older = await store.repo.createConversation(USER, { subject: "Physics", topic: "Heat" });
    const newer = await store.repo.createConversation(USER, {});
    await store.repo.updateConversation(USER, newer.id, { title: "What is entropy?" });
    await store.repo.createConversation("22222222-2222-4222-8222-222222222222", {}); // someone else
    const res = await app.inject({ url: "/api/dashboard", headers: { authorization: "Bearer good" } });
    const { activity } = dashboardSchema.parse(res.json());
    expect(activity.map((a) => a.title)).toEqual(["What is entropy?", "New conversation"]);
    expect(activity[0]).toMatchObject({ type: "tutor", href: `/tutor/${newer.id}`, detail: null });
    expect(activity[1]).toMatchObject({ detail: "Physics · Heat", href: `/tutor/${older.id}` });
  });

  it("shows real quiz results: the average of finished attempts and one activity row per attempt", async () => {
    transaction.mockResolvedValue([{ displayName: "Rahul", timezone: "UTC" }]);
    const quiz = await quizStore.repo.createQuiz({ userId: USER, title: "Heat quiz", sourceType: "topic", subject: "Physics", topic: "Heat", focus: null, difficulty: "easy", questionCount: 2, questionTypes: ["mcq"], timeLimitMinutes: null, documentIds: [] });
    await quizStore.repo.completeGeneration(
      USER,
      quiz.id,
      [0, 1].map((order) => ({ order, type: "mcq" as const, text: `Q${order}`, options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "because", topic: "Heat", difficulty: "easy" as const, sourceRef: null })),
      { provider: "mock", model: "mock-demo", isMock: true },
    );
    const finish = async (score: number) => {
      const a = await quizStore.repo.createAttempt(USER, quiz.id, [], null);
      await quizStore.repo.finalizeAttempt(USER, a.id, { status: "submitted", submittedAt: new Date(), score, total: 2, percentage: (score / 2) * 100, timeTakenSeconds: 30, graded: [] });
      return a.id;
    };
    await finish(2); // 100%
    const second = await finish(1); // 50%
    await quizStore.repo.createAttempt(USER, quiz.id, [], null); // unfinished: must not count
    const d = dashboardSchema.parse((await app.inject({ url: "/api/dashboard", headers: { authorization: "Bearer good" } })).json());
    expect(d.today.quizAveragePercent).toBe(75);
    const rows = d.activity.filter((a) => a.type === "quiz");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === `quiz-${second}`)).toMatchObject({ title: "Heat quiz", detail: "1/2 · 50%", href: `/quiz/attempt/${second}/result` });
  });

  it("returns 404 when the profile row is not visible to the user", async () => {
    transaction.mockResolvedValue([]);
    const res = await app.inject({ url: "/api/dashboard", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(404);
  });
});
