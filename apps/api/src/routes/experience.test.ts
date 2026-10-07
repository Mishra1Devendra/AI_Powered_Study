import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { dashboardSchema, notificationsResponseSchema, searchResponseSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryPlannerRepository } from "../planner/testing/memory.js";
import { createInMemoryProgressRepository } from "../progress/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { createInMemoryExtrasRepository } from "../recommendations/testing/memory.js";
import { createInMemorySearchRepository } from "../search/testing/memory.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";
import { createInMemoryVivaRepository } from "../viva/testing/memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const DOC_A = "d1000000-0000-4000-8000-00000000000a";
const DOC_B = "d1000000-0000-4000-8000-00000000000b";

describe("Phase 12 routes: search, notifications, continue learning", () => {
  let app: FastifyInstance;
  const tutor = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutor);
  const quiz = createInMemoryQuizRepository(notes.repo);
  const viva = createInMemoryVivaRepository();
  const search = createInMemorySearchRepository();
  // The dashboard reads the profile with a real query; here it is a fake that always returns one row.
  const db = { transaction: vi.fn(async () => [{ displayName: "Alice", timezone: "UTC" }]) } as unknown as Database;

  beforeAll(async () => {
    app = await buildApp({
      env, db, ai: new MockProvider(0), verifyToken,
      tutorRepo: tutor.repo, notesRepo: notes.repo, quizRepo: quiz.repo, vivaRepo: viva.repo, searchRepo: search.repo,
      plannerRepo: createInMemoryPlannerRepository().repo, progressRepo: createInMemoryProgressRepository().repo, extrasRepo: createInMemoryExtrasRepository().repo,
    });
    search.add("documents", { userId: A, id: DOC_A, title: "Thermodynamics notes", detail: "thermo.pdf", href: `/notes/${DOC_A}` });
    search.add("documents", { userId: B, id: DOC_B, title: "Thermochemistry secrets", detail: null, href: `/notes/${DOC_B}` });
    search.add("quizzes", { userId: A, id: "q1", title: "Heat quiz", detail: "Physics · Heat", href: "/quiz/q1", text: "Physics Heat" });
    search.addTopic(A, "Physics", "Thermodynamics");
    search.addTopic(B, "Chemistry", "Thermal decomposition");
  });
  afterAll(() => app.close());

  const get = (url: string, who: string | null) => app.inject({ method: "GET", url, ...(who ? { headers: bearer(who) } : {}) });

  describe("GET /api/search", () => {
    it("requires a valid token and calls nothing without one", async () => {
      const before = search.calls.length;
      for (const headers of [{}, { authorization: "Bearer bogus" }]) expect((await app.inject({ method: "GET", url: "/api/search?q=heat", headers })).statusCode).toBe(401);
      expect(search.calls.length).toBe(before);
    });

    it.each([
      ["no query", "/api/search"],
      ["empty", "/api/search?q="],
      ["one character", "/api/search?q=a"],
      ["only spaces", "/api/search?q=%20%20%20"],
      ["too long", `/api/search?q=${"x".repeat(81)}`],
    ])("rejects %s with 400 before touching the database", async (_l, url) => {
      const before = search.calls.length;
      const res = await get(url, A);
      expect(res.statusCode).toBe(400);
      expect(search.calls.length).toBe(before);
    });

    it("returns the student's own matches, grouped, with in-app links", async () => {
      const res = await get("/api/search?q=thermo", A);
      expect(res.statusCode).toBe(200);
      const body = searchResponseSchema.parse(res.json());
      expect(body.documents).toEqual([{ id: DOC_A, title: "Thermodynamics notes", detail: "thermo.pdf", href: `/notes/${DOC_A}` }]);
      expect(body.topics).toEqual([{ subject: "Physics", topic: "Thermodynamics" }]);
      expect(body.quizzes).toEqual([]);
    });

    it("never returns another student's records - not even when their words match better, or a user id is supplied", async () => {
      const mine = searchResponseSchema.parse((await get("/api/search?q=thermo", A)).json());
      const theirs = searchResponseSchema.parse((await get("/api/search?q=thermo", B)).json());
      expect(JSON.stringify(mine)).not.toMatch(/secrets|Chemistry|decomposition/);
      expect(JSON.stringify(theirs)).not.toMatch(/Thermodynamics notes|thermo\.pdf|Physics/);
      expect(theirs.documents.map((d) => d.id)).toEqual([DOC_B]);
      // a user id in the request is ignored: identity comes only from the token
      const sneaky = searchResponseSchema.parse((await get(`/api/search?q=thermo&userId=${A}&user_id=${A}`, B)).json());
      expect(sneaky.documents.map((d) => d.id)).toEqual([DOC_B]);
      expect(search.calls.at(-1)).toMatchObject({ userId: B });
    });

    it("no matches is a normal, empty answer", async () => {
      const body = searchResponseSchema.parse((await get("/api/search?q=zzzz", A)).json());
      expect([body.documents, body.quizzes, body.plans, body.conversations, body.topics].every((g) => g.length === 0)).toBe(true);
    });

    it("a database failure is a calm 500 without internals", async () => {
      search.knobs.fail = true;
      const res = await get("/api/search?q=heat", A);
      search.knobs.fail = false;
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toMatch(/ECONNREFUSED|5432|127\.0\.0\.1/);
      expect(res.json()).toEqual({ error: "internal_error", message: "Something went wrong." });
    });
  });

  describe("GET /api/notifications", () => {
    it("requires a valid token", async () => {
      expect((await get("/api/notifications", null)).statusCode).toBe(401);
      expect((await get("/api/notifications", "bogus")).statusCode).toBe(401);
    });

    it("is empty for a student with no records, and valid", async () => {
      const body = notificationsResponseSchema.parse((await get("/api/notifications", B)).json());
      expect(body).toEqual({ notifications: [], partial: false });
    });

    it("shows the student's own fresh quiz result - and only theirs", async () => {
      const q = await quiz.repo.createQuiz({ userId: A, title: "Heat quiz", sourceType: "topic", subject: "Physics", topic: "Heat", focus: null, difficulty: "easy", questionCount: 2, questionTypes: ["mcq"], timeLimitMinutes: null, documentIds: [] });
      await quiz.repo.completeGeneration(
        A, q.id,
        [0, 1].map((order) => ({ order, type: "mcq" as const, text: `Q${order}`, options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "x", topic: "Heat", difficulty: "easy" as const, sourceRef: null })),
        { provider: "mock", model: "mock-demo", isMock: true },
      );
      const attempt = await quiz.repo.createAttempt(A, q.id, [], null);
      await quiz.repo.finalizeAttempt(A, attempt.id, { status: "submitted", submittedAt: new Date(), score: 2, total: 2, percentage: 100, timeTakenSeconds: 20, graded: [] });

      const mine = notificationsResponseSchema.parse((await get("/api/notifications", A)).json());
      expect(mine.notifications.find((n) => n.kind === "quiz_result")).toMatchObject({ id: `quiz_result:${attempt.id}`, title: "Quiz result: 2/2 (100%)", href: `/quiz/attempt/${attempt.id}/result` });
      const theirs = notificationsResponseSchema.parse((await get("/api/notifications", B)).json());
      expect(theirs.notifications).toEqual([]);
    });
  });

  describe("GET /api/dashboard: continue learning", () => {
    it("offers a quiz the student left unfinished, and an unfinished viva when there is no quiz - for that student only", async () => {
      const q = await quiz.repo.createQuiz({ userId: A, title: "Optics quiz", sourceType: "topic", subject: "Physics", topic: "Optics", focus: null, difficulty: "easy", questionCount: 2, questionTypes: ["mcq"], timeLimitMinutes: null, documentIds: [] });
      await quiz.repo.completeGeneration(
        A, q.id,
        [0, 1].map((order) => ({ order, type: "mcq" as const, text: `Q${order}`, options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "x", topic: "Optics", difficulty: "easy" as const, sourceRef: null })),
        { provider: "mock", model: "mock-demo", isMock: true },
      );
      const open = await quiz.repo.createAttempt(A, q.id, [], null);

      const mine = dashboardSchema.parse((await get("/api/dashboard", A)).json());
      expect(mine.resume).toMatchObject({ kind: "quiz", title: "Finish Optics quiz", href: `/quiz/attempt/${open.id}` });
      const theirs = dashboardSchema.parse((await get("/api/dashboard", B)).json());
      expect(theirs.resume ?? null).toBeNull();

      // an unfinished viva is offered to its owner too
      await viva.repo.createSession({
        userId: B, subject: "Chemistry", topic: "Rates", difficulty: "easy", questionCount: 3, model: "m", isMock: false, sourceType: "general", documentId: null,
        firstQuestion: { text: "Why does heat speed reactions?", concept: "Rate", keyPoints: ["energy"], isFollowUp: false },
      });
      const b = dashboardSchema.parse((await get("/api/dashboard", B)).json());
      expect(b.resume).toMatchObject({ kind: "viva", title: "Continue your viva on Rates", detail: "Question 1 of 3" });
    });
  });
});
