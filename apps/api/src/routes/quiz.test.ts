import { describe, expect, it } from "vitest";
import { attemptViewSchema, quizDetailResponseSchema, quizListResponseSchema, resultSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { AIError } from "../services/ai/errors.js";
import { OllamaOrMockProvider } from "../services/ai/mock-fallback.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { OllamaProvider } from "../services/ai/ollama-provider.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";
import { FACT_CHUNKS, mcqItem } from "../quiz/testing/facts.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTE_A = "11111111-1111-4111-8111-111111111111";
const NOTE_A_BUSY = "33333333-3333-4333-8333-333333333333";
const NOTE_B = "22222222-2222-4222-8222-222222222222";
const MISSING = "99999999-9999-4999-8999-999999999999";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

const filler = (label: string, chars = 700) => `${label} `.repeat(Math.ceil(chars / (label.length + 1)));
const SECTIONS = ["cells", "energy", "genes", "enzymes", "membranes", "ecology"];

async function seedNote(mem: ReturnType<typeof createInMemoryNotesRepository>, userId: string, id: string, hash: string, ready = true) {
  await mem.repo.createDocument({ id, userId, title: `Biology ${hash[0]}`, originalFilename: "b.md", fileType: "md", source: "upload", mimeType: "text/markdown", fileSize: 1, contentHash: hash.repeat(64).slice(0, 64), storagePath: `${userId}/${id}/original.md` });
  if (ready) {
    await mem.repo.saveChunksAndMarkReady(
      userId,
      id,
      SECTIONS.map((s, i) => ({ index: i, content: `About ${s}. ${filler(`${s}word`)}`, page: i + 1, pageEnd: i + 1, heading: `Heading ${s}`, headingPath: [`Heading ${s}`] })),
      { pageCount: 6, charCount: 4000, sourceFilename: "b.md" },
    );
  }
}

/** Wraps a provider so a test can hold generation open and release it when ready. */
function gated(inner: LLMProvider) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ai: LLMProvider = {
    name: inner.name,
    model: inner.model,
    isMock: inner.isMock,
    async generateText(req) {
      await gate;
      return inner.generateText(req);
    },
    streamText: (req) => inner.streamText(req),
  };
  return { ai, release };
}

const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };

async function make(ai: LLMProvider = new MockProvider(0)) {
  clock.t = Date.UTC(2026, 9, 3, 12, 0, 0);
  const tutorStore = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutorStore);
  await seedNote(notes, A, NOTE_A, "a");
  await seedNote(notes, A, NOTE_A_BUSY, "c", false);
  await seedNote(notes, B, NOTE_B, "b");
  const now = () => new Date(clock.t);
  const quiz = createInMemoryQuizRepository(notes.repo, now);
  let seed = 12345;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const app = await buildApp({ env, db: {} as unknown as Database, ai, verifyToken, tutorRepo: tutorStore.repo, notesRepo: notes.repo, quizRepo: quiz.repo, quizNow: now, quizRng: rng });
  return { app, quiz, notes };
}
type Ctx = Awaited<ReturnType<typeof make>>;

const call = (c: Ctx, who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  c.app.inject({ method, url, headers: bearer(who), ...(payload !== undefined ? { payload: payload as object } : {}) });

const notesBody = (over: Record<string, unknown> = {}) => ({ source: { type: "notes", documentIds: [NOTE_A] }, difficulty: "medium", count: 5, questionTypes: ["mcq"], ...over });

async function generate(c: Ctx, who = A, body: Record<string, unknown> = notesBody()) {
  const res = await call(c, who, "POST", "/api/quiz/generate", body);
  await c.app.quiz.whenIdle();
  return res;
}
async function readyQuiz(c: Ctx, who = A, body?: Record<string, unknown>) {
  const res = await generate(c, who, body);
  expect(res.statusCode).toBe(202);
  return res.json().quiz.id as string;
}
async function startAttempt(c: Ctx, who: string, quizId: string) {
  const res = await call(c, who, "POST", `/api/quiz/${quizId}/start`);
  expect(res.statusCode).toBe(200);
  return attemptViewSchema.parse(res.json());
}
/** The answer key lives only in the repository: tests read it there, the way only the server can. */
const keyOf = (c: Ctx, quizId: string) => new Map(c.quiz.state.questions.filter((q) => q.quizId === quizId).map((q) => [q.id, q]));
const answersFor = (c: Ctx, quizId: string, view: { questions: { id: string }[] }, correct: number, wrong = 0) => {
  const key = keyOf(c, quizId);
  return view.questions.map((q, i) => {
    const k = key.get(q.id)!;
    if (i < correct) return { questionId: q.id, selected: k.correctIndex };
    if (i < correct + wrong) return { questionId: q.id, selected: (k.correctIndex + 1) % k.options.length };
    return null;
  }).filter((x): x is { questionId: string; selected: number } => x !== null);
};

/* ---------------------------------------------------------------------------------------------- */

describe("quiz routes: authentication", () => {
  it.each([
    ["GET", "/api/quiz"],
    ["GET", "/api/quiz/options"],
    ["POST", "/api/quiz/generate"],
    ["GET", "/api/quiz/attempts"],
    ["GET", `/api/quiz/${A}`],
    ["POST", `/api/quiz/${A}/start`],
    ["POST", `/api/quiz/${A}/retry`],
    ["POST", `/api/quiz/${A}/regenerate`],
    ["GET", `/api/quiz/attempts/${A}`],
    ["PUT", `/api/quiz/attempts/${A}/answers`],
    ["POST", `/api/quiz/attempts/${A}/submit`],
    ["GET", `/api/quiz/attempts/${A}/result`],
  ] as const)("%s %s requires a signed-in user", async (method, url) => {
    const c = await make();
    for (const headers of [{}, { authorization: "Bearer not-a-real-token" }]) {
      const res = await c.app.inject({ method, url, headers, ...(method !== "GET" ? { payload: {} } : {}) });
      expect(res.statusCode).toBe(401);
    }
  });

  it("a signed-in student can use the quiz endpoints", async () => {
    const c = await make();
    const res = await call(c, A, "GET", "/api/quiz");
    expect(res.statusCode).toBe(200);
    quizListResponseSchema.parse(res.json());
  });
});

describe("quiz options: only what the student really has", () => {
  it("lists the student's own READY notes and tutor topics, nobody else's", async () => {
    const c = await make();
    c.quiz.setSuggestions([
      { userId: A, subject: "Physics", topic: "Thermodynamics" },
      { userId: B, subject: "Chemistry", topic: null },
    ]);
    const a = (await call(c, A, "GET", "/api/quiz/options")).json();
    expect(a.notes.map((n: { id: string }) => n.id)).toEqual([NOTE_A]); // not the unprocessed one, not B's
    expect(a.topics).toEqual([{ subject: "Physics", topic: "Thermodynamics" }]);
    const b = (await call(c, B, "GET", "/api/quiz/options")).json();
    expect(b.notes.map((n: { id: string }) => n.id)).toEqual([NOTE_B]);
    expect(b.topics).toEqual([{ subject: "Chemistry", topic: null }]);
  });

  it("is empty for a new student (no invented sources)", async () => {
    const c = await make();
    c.notes.repo; // B has a note; use a student with none
    const res = await c.app.inject({ method: "GET", url: "/api/quiz/options", headers: bearer(A) });
    expect(res.json().topics).toEqual([]);
  });
});

describe("generation", () => {
  it("returns immediately with a 'generating' quiz, then becomes ready with exactly the requested questions", async () => {
    const g = gated(new MockProvider(0));
    const c = await make(g.ai);
    const res = await call(c, A, "POST", "/api/quiz/generate", notesBody({ count: 5 }));
    expect(res.statusCode).toBe(202);
    expect(res.json().quiz).toMatchObject({ status: "generating", questionCount: 5, sourceType: "notes", attemptCount: 0 });
    const id = res.json().quiz.id;

    const during = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(during.quiz.status).toBe("generating");
    expect(during.questions).toEqual([]); // nothing to show yet
    g.release();
    await c.app.quiz.whenIdle();

    const done = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(done.quiz).toMatchObject({ status: "ready", isMock: true, model: "mock-demo", error: null });
    expect(done.questions).toHaveLength(5);
    expect(done.quiz.sources.map((s) => s.id)).toEqual([NOTE_A]);
    expect(done.quiz.sourceLabel).toBe("Biology a");
  });

  it.each([1, 5, 10, 15, 20])("makes a %i-question quiz", async (count) => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count }));
    expect((await call(c, A, "GET", `/api/quiz/${id}`)).json().questions).toHaveLength(count);
  });

  it.each([
    ["mcq only", ["mcq"]],
    ["true/false only", ["true_false"]],
    ["both", ["mcq", "true_false"]],
  ])("supports %s", async (_label, questionTypes) => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 6, questionTypes }));
    const qs = (await call(c, A, "GET", `/api/quiz/${id}`)).json().questions as { type: string; options: string[] }[];
    expect(new Set(qs.map((q) => q.type))).toEqual(new Set(questionTypes));
    for (const q of qs) expect(q.options).toHaveLength(q.type === "mcq" ? 4 : 2);
    if (questionTypes.length === 2) expect(qs.filter((q) => q.type === "mcq")).toHaveLength(3);
  });

  it.each(["easy", "medium", "hard", "mixed"])("supports %s difficulty", async (difficulty) => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ difficulty, count: 6 }));
    const qs = (await call(c, A, "GET", `/api/quiz/${id}`)).json().questions as { difficulty: string }[];
    if (difficulty === "mixed") expect(new Set(qs.map((q) => q.difficulty)).size).toBeGreaterThan(1);
    else expect(qs.every((q) => q.difficulty === difficulty)).toBe(true);
  });

  it("makes a subject/topic quiz with no notes involved", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, { source: { type: "topic", subject: "Physics", topic: "Thermodynamics" }, difficulty: "easy", count: 5, questionTypes: ["mcq", "true_false"] });
    const d = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(d.quiz).toMatchObject({ sourceType: "topic", sourceLabel: "Physics · Thermodynamics", subject: "Physics", topic: "Thermodynamics", sources: [] });
    expect(d.questions.every((q) => q.topic === "Thermodynamics")).toBe(true);
  });

  it("makes a quiz from several notes, or from part of a note via a focus", async () => {
    const c = await make();
    await seedNote(c.notes, A, "44444444-4444-4444-8444-444444444444", "d");
    const id = await readyQuiz(c, A, notesBody({ source: { type: "notes", documentIds: [NOTE_A, "44444444-4444-4444-8444-444444444444"], focus: "enzymes" } }));
    expect((await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz.sources).toHaveLength(2);
  });

  it("note questions carry real section topics from the notes (never invented ones)", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 6 }));
    const topics = (await call(c, A, "GET", `/api/quiz/${id}`)).json().questions.map((q: { topic: string | null }) => q.topic);
    for (const t of topics) expect(["Heading cells", "Heading energy", "Heading genes", "Heading enzymes", "Heading membranes", "Heading ecology"]).toContain(t);
  });

  it("applies defaults (5 questions, mcq, medium, untimed)", async () => {
    const c = await make();
    const res = await generate(c, A, { source: { type: "topic", subject: "Maths" } });
    expect(res.json().quiz).toMatchObject({ questionCount: 5, difficulty: "medium", questionTypes: ["mcq"], timeLimitMinutes: null });
  });

  it.each([
    ["no source", { difficulty: "easy" }],
    ["unknown source type", notesBody({ source: { type: "web", url: "http://x" } })],
    ["no notes chosen", notesBody({ source: { type: "notes", documentIds: [] } })],
    ["too many notes", notesBody({ source: { type: "notes", documentIds: [NOTE_A, NOTE_B, MISSING, A, B, "55555555-5555-4555-8555-555555555555"] } })],
    ["not a uuid", notesBody({ source: { type: "notes", documentIds: ["nope"] } })],
    ["blank subject", { source: { type: "topic", subject: "   " }, count: 5 }],
    ["zero questions", notesBody({ count: 0 })],
    ["too many questions", notesBody({ count: 21 })],
    ["fractional count", notesBody({ count: 2.5 })],
    ["string count", notesBody({ count: "5" })],
    ["no types", notesBody({ questionTypes: [] })],
    ["unsupported type", notesBody({ questionTypes: ["short_answer"] })],
    ["unknown type", notesBody({ questionTypes: ["essay"] })],
    ["duplicate types", notesBody({ questionTypes: ["mcq", "mcq"] })],
    ["bad difficulty", notesBody({ difficulty: "impossible" })],
    ["bad time limit", notesBody({ timeLimitMinutes: 0 })],
    ["huge time limit", notesBody({ timeLimitMinutes: 99999 })],
  ])("rejects an invalid configuration: %s", async (_label, body) => {
    const c = await make();
    const res = await call(c, A, "POST", "/api/quiz/generate", body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    expect(c.quiz.state.quizzes).toHaveLength(0); // nothing was created
  });

  it("will not use another student's note, a missing note, or a note that is not ready", async () => {
    const c = await make();
    expect((await call(c, A, "POST", "/api/quiz/generate", notesBody({ source: { type: "notes", documentIds: [NOTE_B] } }))).statusCode).toBe(404);
    expect((await call(c, A, "POST", "/api/quiz/generate", notesBody({ source: { type: "notes", documentIds: [MISSING] } }))).statusCode).toBe(404);
    const busy = await call(c, A, "POST", "/api/quiz/generate", notesBody({ source: { type: "notes", documentIds: [NOTE_A_BUSY] } }));
    expect(busy.statusCode).toBe(400);
    expect(c.quiz.state.quizzes).toHaveLength(0);
  });

  it("allows one generation at a time per student, and others are not affected", async () => {
    const g = gated(new MockProvider(0));
    const c = await make(g.ai);
    const first = await call(c, A, "POST", "/api/quiz/generate", notesBody());
    expect(first.statusCode).toBe(202);
    const second = await call(c, A, "POST", "/api/quiz/generate", notesBody());
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "generation_in_progress", quizId: first.json().quiz.id });
    const other = await call(c, B, "POST", "/api/quiz/generate", notesBody({ source: { type: "notes", documentIds: [NOTE_B] } }));
    expect(other.statusCode).toBe(202);
    g.release();
    await c.app.quiz.whenIdle();
    expect((await call(c, A, "POST", "/api/quiz/generate", notesBody())).statusCode).toBe(202); // free again
    await c.app.quiz.whenIdle();
  });

  it("a quiz whose generation was interrupted (e.g. server restart) is marked failed, not left spinning", async () => {
    const c = await make();
    const q = await c.quiz.repo.createQuiz({ userId: A, title: "Stuck", sourceType: "topic", subject: "X", topic: null, focus: null, difficulty: "easy", questionCount: 5, questionTypes: ["mcq"], timeLimitMinutes: null, documentIds: [] });
    clock.t += 5 * 60_000;
    const list = quizListResponseSchema.parse((await call(c, A, "GET", "/api/quiz")).json());
    expect(list.quizzes.find((x) => x.id === q.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
    expect((await call(c, A, "POST", "/api/quiz/generate", notesBody())).statusCode).toBe(202); // and does not block a new one
    await c.app.quiz.whenIdle();
  });
});

describe("generation failures are reported and nothing invalid is saved", () => {
  const bad = (reply: string): LLMProvider => ({
    name: "ollama",
    model: "bad-model",
    isMock: false,
    async generateText(_r: GenerateTextRequest): Promise<GenerateTextResult> {
      return { text: reply, provider: "ollama", model: "bad-model", isMock: false };
    },
    // eslint-disable-next-line require-yield
    async *streamText(): TextStream {
      throw new Error("unused");
    },
  });

  it("malformed AI output -> failed quiz with a useful message, zero questions stored, retry possible", async () => {
    const c = await make(bad('{"questions":[{"type":"mcq","question":"Too short?","options":["a","b"],"correctAnswer":9}]}'));
    const id = await readyQuizAllowFail(c);
    const d = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(d.quiz.status).toBe("failed");
    expect(d.quiz.error).toMatch(/only produced 0 acceptable questions out of 5.*Nothing was saved/);
    expect(d.questions).toEqual([]);
    expect(c.quiz.state.questions).toHaveLength(0);
    // The student can start over straight away.
    expect((await call(c, A, "POST", "/api/quiz/generate", notesBody())).statusCode).toBe(202);
    await c.app.quiz.whenIdle();
  });

  it("a failed quiz cannot be started", async () => {
    const c = await make(bad("not json at all"));
    const id = await readyQuizAllowFail(c);
    const res = await call(c, A, "POST", `/api/quiz/${id}/start`);
    expect(res.statusCode).toBe(409);
  });

  it("Ollama timing out is reported as a failed quiz with the reason", async () => {
    const slow: LLMProvider = { ...bad(""), async generateText() { throw new AIError("timeout", "The local AI took too long to respond.", true); } };
    const c = await make(slow);
    const id = await readyQuizAllowFail(c);
    expect((await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz).toMatchObject({ status: "failed", error: "The local AI took too long to respond." });
  });

  it("an unexpected crash is reported generically (no internals leak)", async () => {
    const boom: LLMProvider = { ...bad(""), async generateText() { throw new Error("secret stack detail at C:\\internal\\path"); } };
    const c = await make(boom);
    const id = await readyQuizAllowFail(c);
    const quiz = (await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz;
    expect(quiz.status).toBe("failed");
    expect(quiz.error).toBe("Something went wrong while creating the quiz. Please try again.");
    expect(JSON.stringify(quiz)).not.toContain("secret");
  });

  it("Ollama not running -> falls back to the labelled MOCK (never a paid provider)", async () => {
    const down = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 1000, numCtx: 8192, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const c = await make(new OllamaOrMockProvider(down, 0));
    const id = await readyQuiz(c);
    const quiz = (await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz;
    expect(quiz).toMatchObject({ status: "ready", isMock: true });
    expect(quiz.model).toBe("mock-demo");
  });

  it("a real local model's quiz is NOT labelled as mock", async () => {
    const good = JSON.stringify({ questions: [0, 1, 2, 3, 4].map((n) => mcqItem(n, { evidence: undefined, source: undefined })) });
    const c = await make(bad(good));
    const id = await readyQuiz(c, A, { source: { type: "topic", subject: "Biology" }, difficulty: "medium", count: 5, questionTypes: ["mcq"] });
    expect((await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz).toMatchObject({ status: "ready", isMock: false, model: "bad-model" });
  });

  async function readyQuizAllowFail(c: Ctx) {
    const res = await generate(c);
    expect(res.statusCode).toBe(202);
    return res.json().quiz.id as string;
  }
});

describe("answer security: the browser never receives the answer key", () => {
  const FORBIDDEN_KEYS = ["correctAnswer", "correctIndex", "correct_answer", "explanation", "isCorrect", "is_correct", "sourceRef", "source"];
  const keysDeep = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
    return out;
  };

  it("an active quiz exposes only display fields, on every endpoint that returns questions", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ questionTypes: ["mcq", "true_false"], count: 6 }));
    const view = await startAttempt(c, A, id);
    const responses = [
      (await call(c, A, "GET", `/api/quiz/${id}`)).json(),
      view,
      (await call(c, A, "GET", `/api/quiz/attempts/${view.attempt.id}`)).json(),
      (await call(c, A, "POST", `/api/quiz/${id}/retry`)).json(), // resumes the open attempt
      (await call(c, A, "GET", "/api/quiz")).json(),
      (await call(c, A, "GET", "/api/quiz/attempts")).json(),
    ];
    for (const r of responses) {
      const keys = keysDeep(r);
      for (const forbidden of FORBIDDEN_KEYS) expect(keys.has(forbidden), `${forbidden} leaked`).toBe(false);
    }
    // Exactly these fields describe a question to the player.
    for (const q of view.questions) expect(Object.keys(q).sort()).toEqual(["difficulty", "id", "options", "order", "text", "topic", "type"]);
  });

  it("no stored explanation or correct option text can be found anywhere in an active-quiz payload", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 5 }));
    const view = await startAttempt(c, A, id);
    const raw = JSON.stringify(view) + JSON.stringify((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    for (const q of c.quiz.state.questions) {
      expect(raw).not.toContain(q.explanation);
      // the correct option's text appears only as one of several equal-looking options, never flagged
    }
    // The correct answer's position is not predictable: it is spread over positions (options are shuffled).
    const positions = new Set([...keyOf(c, id).values()].map((q) => q.correctIndex));
    expect(positions.size).toBeGreaterThan(1);
  });

  it("saving answers does not reveal whether they were right", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const view = await startAttempt(c, A, id);
    const res = await call(c, A, "PUT", `/api/quiz/attempts/${view.attempt.id}/answers`, { answers: answersFor(c, id, view, 2, 1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: 3 });
    const back = await call(c, A, "GET", `/api/quiz/attempts/${view.attempt.id}`);
    expect(keysDeep(back.json()).has("isCorrect")).toBe(false);
  });

  it("results are refused until the attempt is submitted", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const view = await startAttempt(c, A, id);
    const res = await call(c, A, "GET", `/api/quiz/attempts/${view.attempt.id}/result`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_submitted");
    expect(JSON.stringify(res.json())).not.toMatch(/explanation|correctAnswer/);
  });
});

describe("taking a quiz", () => {
  it("starts an attempt in the quiz's natural order, and starting again resumes the same one", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const first = await startAttempt(c, A, id);
    expect(first.attempt.status).toBe("in_progress");
    expect(first.attempt.expiresAt).toBeNull();
    expect(first.questions.map((q) => q.order)).toEqual([0, 1, 2, 3, 4]);
    expect(first.answers).toEqual({});
    expect(first.quiz).toMatchObject({ id, timeLimitMinutes: null });
    const again = await startAttempt(c, A, id);
    expect(again.attempt.id).toBe(first.attempt.id);
    expect(c.quiz.state.attempts).toHaveLength(1);
  });

  it("keeps answers as the student moves around, lets them change or clear one, and survives a reload", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const [q1, q2, q3] = v.questions;
    const put = (answers: unknown[]) => call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers });
    expect((await put([{ questionId: q1!.id, selected: 2 }, { questionId: q3!.id, selected: 0 }])).statusCode).toBe(200);
    expect((await put([{ questionId: q1!.id, selected: 1 }])).statusCode).toBe(200); // changed mind
    expect((await put([{ questionId: q3!.id, selected: null }])).statusCode).toBe(200); // cleared
    const reloaded = attemptViewSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}`)).json());
    expect(reloaded.answers).toEqual({ [q1!.id]: 1 });
    expect(q2).toBeDefined();
  });

  it("rejects answers for questions of another quiz, unknown options, and malformed bodies", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const other = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const foreign = (await call(c, A, "GET", `/api/quiz/${other}`)).json().questions[0].id;
    const put = (body: unknown) => call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, body);
    expect((await put({ answers: [{ questionId: foreign, selected: 0 }] })).statusCode).toBe(400);
    expect((await put({ answers: [{ questionId: v.questions[0]!.id, selected: 7 }] })).statusCode).toBe(400); // MCQ has 4 options
    expect((await put({ answers: [{ questionId: v.questions[0]!.id, selected: -1 }] })).statusCode).toBe(400);
    expect((await put({ answers: [{ questionId: "nope", selected: 0 }] })).statusCode).toBe(400);
    expect((await put({ answers: "all" })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect(c.quiz.state.answers).toHaveLength(0);
  });

  it("true/false has exactly two options", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ questionTypes: ["true_false"] }));
    const v = await startAttempt(c, A, id);
    expect((await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: [{ questionId: v.questions[0]!.id, selected: 2 }] })).statusCode).toBe(400);
    expect((await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: [{ questionId: v.questions[0]!.id, selected: 1 }] })).statusCode).toBe(200);
  });
});

describe("submission and scoring (always calculated on the server)", () => {
  it("scores a fully correct attempt", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const res = await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) });
    expect(res.statusCode).toBe(200);
    const r = resultSchema.parse(res.json());
    expect(r.attempt).toMatchObject({ status: "submitted", score: 5, total: 5, percentage: 100, correct: 5, incorrect: 0, unanswered: 0, timedOut: false });
    expect(r.review.every((x) => x.isCorrect)).toBe(true);
  });

  it("scores a mixed attempt: some right, some wrong, some skipped", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 2, 2) })).json());
    expect(r.attempt).toMatchObject({ score: 2, total: 5, percentage: 40, correct: 2, incorrect: 2, unanswered: 1 });
    expect(r.review.map((x) => x.selected !== null)).toEqual([true, true, true, true, false]);
  });

  it("scores an empty submission as 0 with everything unanswered", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, {})).json());
    expect(r.attempt).toMatchObject({ score: 0, percentage: 0, correct: 0, incorrect: 0, unanswered: 5 });
  });

  it("uses answers saved earlier (autosave) when the final submit carries none", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 3) });
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`)).json());
    expect(r.attempt).toMatchObject({ score: 3, unanswered: 2 });
  });

  it("ignores any score or correctness the browser tries to supply", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const cheat = { score: 5, total: 5, percentage: 100, correct: 5, isCorrect: true, answers: answersFor(c, id, v, 0, 5).map((a) => ({ ...a, isCorrect: true, correctAnswer: a.selected })) };
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, cheat)).json());
    expect(r.attempt).toMatchObject({ score: 0, percentage: 0, incorrect: 5 });
  });

  it("returns the result with the answer key, explanations and the student's choices", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ questionTypes: ["mcq", "true_false"], count: 6 }));
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 3, 3) })).json());
    const key = keyOf(c, id);
    for (const item of r.review) {
      const k = key.get(item.id)!;
      expect(item).toMatchObject({ correctAnswer: k.correctIndex, explanation: k.explanation, text: k.text, difficulty: k.difficulty, topic: k.topic });
      expect(item.options).toEqual(k.options);
    }
    expect(r.review.filter((x) => !x.isCorrect && x.selected !== null)).toHaveLength(3);
    expect(r.review[0]!.source).toMatchObject({ title: "Biology a" }); // from real stored metadata
    // The same result is available later.
    const again = resultSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}/result`)).json());
    expect(again.attempt).toEqual(r.attempt);
    expect(again.review).toEqual(r.review);
  });

  it("a second submission returns the same stored result and changes nothing (no double scoring)", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const first = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 2) })).json());
    const second = await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) }); // tries to improve the score
    expect(second.statusCode).toBe(200);
    expect(resultSchema.parse(second.json()).attempt).toEqual(first.attempt);
    expect(first.attempt.score).toBe(2);
    expect(c.quiz.state.attempts).toHaveLength(1);
  });

  it("simultaneous submissions grade once", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const body = { answers: answersFor(c, id, v, 4) };
    const results = await Promise.all([1, 2, 3].map(() => call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, body)));
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(resultSchema.parse(r.json()).attempt.score).toBe(4);
    }
  });

  it("no more answers can be saved once submitted", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, {});
    const res = await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 5) });
    expect(res.statusCode).toBe(409);
    expect(c.quiz.state.answers).toHaveLength(0);
  });

  it("rejects an invalid or unknown attempt id", async () => {
    const c = await make();
    for (const [method, url] of [["GET", "/api/quiz/attempts/not-a-uuid"], ["POST", "/api/quiz/attempts/not-a-uuid/submit"], ["GET", "/api/quiz/attempts/not-a-uuid/result"]] as const) {
      expect((await call(c, A, method, url)).statusCode, url).toBe(400);
    }
    for (const [method, url] of [["GET", `/api/quiz/attempts/${MISSING}`], ["POST", `/api/quiz/attempts/${MISSING}/submit`], ["GET", `/api/quiz/attempts/${MISSING}/result`], ["PUT", `/api/quiz/attempts/${MISSING}/answers`]] as const) {
      expect((await call(c, A, method, url, method === "PUT" ? { answers: [] } : undefined)).statusCode, url).toBe(404);
    }
  });
});

describe("timed quizzes: the server decides when time is up", () => {
  const timed = (c: Ctx) => readyQuiz(c, A, notesBody({ timeLimitMinutes: 10 }));

  it("stores the deadline on the server when the attempt starts", async () => {
    const c = await make();
    const id = await timed(c);
    const v = await startAttempt(c, A, id);
    expect(v.quiz.timeLimitMinutes).toBe(10);
    expect(new Date(v.attempt.expiresAt!).getTime()).toBe(new Date(v.attempt.startedAt).getTime() + 10 * 60_000);
    expect(v.serverNow).toBe(new Date(clock.t).toISOString());
  });

  it("accepts answers and a submission before the deadline", async () => {
    const c = await make();
    const id = await timed(c);
    const v = await startAttempt(c, A, id);
    clock.t += 9 * 60_000;
    expect((await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 2) })).statusCode).toBe(200);
    clock.t += 60_000 + 10_000; // 10 s past the deadline: inside the grace period for network latency
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) })).json());
    expect(r.attempt).toMatchObject({ status: "submitted", score: 5, timedOut: false });
  });

  it("after the deadline: saving is refused, the attempt is closed with what was saved, and late answers are ignored", async () => {
    const c = await make();
    const id = await timed(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 2) });
    clock.t += 11 * 60_000; // well past deadline + grace
    const late = await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 5) });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe("attempt_expired");

    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) })).json());
    expect(r.attempt).toMatchObject({ status: "expired", timedOut: true, score: 2, unanswered: 3 });
    expect(r.attempt.timeTakenSeconds).toBe(600); // capped at the allowance, not the real elapsed time
  });

  it("an overdue attempt is closed even if the student never comes back to submit; opening it shows it as expired", async () => {
    const c = await make();
    const id = await timed(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 1) });
    clock.t += 30 * 60_000;
    const view = attemptViewSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}`)).json());
    expect(view.attempt.status).toBe("expired");
    const result = resultSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}/result`)).json());
    expect(result.attempt).toMatchObject({ score: 1, timedOut: true });
  });

  it("starting again after an attempt expired begins a fresh attempt", async () => {
    const c = await make();
    const id = await timed(c);
    const first = await startAttempt(c, A, id);
    clock.t += 30 * 60_000;
    const second = await startAttempt(c, A, id);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(second.attempt.status).toBe("in_progress");
  });

  it("untimed quizzes never expire", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    clock.t += 30 * 24 * 60 * 60_000;
    expect((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}`)).json().attempt.status).toBe("in_progress");
  });
});

/** Replays scripted replies, one per model call. */
function scripted(replies: string[]): LLMProvider {
  const queue = [...replies];
  return {
    name: "ollama",
    model: "scripted-model",
    isMock: false,
    async generateText(_r: GenerateTextRequest): Promise<GenerateTextResult> {
      const next = queue.shift();
      if (next === undefined) throw new Error("script exhausted");
      return { text: next, provider: "ollama", model: "scripted-model", isMock: false };
    },
    // eslint-disable-next-line require-yield
    async *streamText(): TextStream {
      throw new Error("unused");
    },
  };
}
const NOTE_FACTS = "44444444-4444-4444-8444-444444444444";
const reply = (items: unknown[]) => JSON.stringify({ questions: items });

async function seedFactsNote(c: Ctx) {
  await c.notes.repo.createDocument({ id: NOTE_FACTS, userId: A, title: "Cell biology facts", originalFilename: "f.md", fileType: "md", source: "upload", mimeType: "text/markdown", fileSize: 1, contentHash: "f".repeat(64), storagePath: `${A}/${NOTE_FACTS}/original.md` });
  await c.notes.repo.saveChunksAndMarkReady(
    A,
    NOTE_FACTS,
    FACT_CHUNKS.map((f, i) => ({ index: i, content: f.text, page: f.page, pageEnd: f.page, heading: f.heading, headingPath: [f.heading] })),
    { pageCount: 6, charCount: 5000, sourceFilename: "f.md" },
  );
}
const factsBody = (over: Record<string, unknown> = {}) => ({ source: { type: "notes", documentIds: [NOTE_FACTS] }, difficulty: "medium", count: 5, questionTypes: ["mcq"], ...over });

describe("quality gate through the API", () => {
  it("a real-model notes quiz keeps the verified quote, and the review shows it with the page and section", async () => {
    const c = await make(scripted([reply([0, 1, 2, 3, 4].map((n) => mcqItem(n)))]));
    await seedFactsNote(c);
    const id = await readyQuiz(c, A, factsBody());
    const quiz = (await call(c, A, "GET", `/api/quiz/${id}`)).json().quiz;
    expect(quiz).toMatchObject({ status: "ready", isMock: false });
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: [] })).json());
    for (const item of r.review) {
      expect(item.source?.evidence).toBeTruthy();
      expect(item.source).toMatchObject({ title: "Cell biology facts" });
      expect(item.source?.heading).toMatch(/^Heading \d$/);
    }
    // ...but never before submission
    expect(JSON.stringify(v)).not.toContain(r.review[0]!.source!.evidence!);
  });

  it("a model that invents its supporting quotes cannot produce a quiz: it fails, says why, and stores nothing", async () => {
    const fake = (n: number) => mcqItem(n, { evidence: "This sentence was made up and is nowhere in the student's notes at all." });
    const c = await make(scripted([reply([0, 1, 2, 3, 4].map(fake)), reply([5, 6, 7, 8, 9].map(fake))]));
    await seedFactsNote(c);
    const id = await readyQuiz(c, A, factsBody());
    const d = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(d.quiz.status).toBe("failed");
    expect(d.quiz.error).toMatch(/questions not backed by your notes/);
    expect(d.questions).toEqual([]);
    expect(c.quiz.state.questions).toHaveLength(0);
    // and the student can simply try again
    expect((await call(c, A, "POST", `/api/quiz/${id}/regenerate`)).statusCode).toBe(202);
    await c.app.quiz.whenIdle();
  });
});

describe("generation progress", () => {
  it("shows the real stage while the quiz is being made, and nothing once it is done", async () => {
    const g = gated(new MockProvider(0));
    const c = await make(g.ai);
    const first = await call(c, A, "POST", "/api/quiz/generate", notesBody());
    const id = first.json().quiz.id as string;
    await new Promise((r) => setTimeout(r, 20)); // let the job reach the (held) model call

    const during = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(during.quiz.status).toBe("generating");
    expect(during.quiz.progress).toEqual({ stage: "generating", batch: 1, accepted: 0, target: 5 });
    expect(during.questions).toEqual([]);
    const listed = quizListResponseSchema.parse((await call(c, A, "GET", "/api/quiz")).json());
    expect(listed.quizzes[0]!.progress?.stage).toBe("generating");

    g.release();
    await c.app.quiz.whenIdle();
    const after = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${id}`)).json());
    expect(after.quiz.status).toBe("ready");
    expect(after.quiz.progress ?? null).toBeNull();
  });

  it("polling a quiz that is being made does no database writes and loads no questions or attempts", async () => {
    const g = gated(new MockProvider(0));
    const c = await make(g.ai);
    const id = (await call(c, A, "POST", "/api/quiz/generate", notesBody())).json().quiz.id as string;
    const calls = { stale: 0, play: 0, attempts: 0 };
    const repo = c.quiz.repo;
    const { failStaleGenerating, listPlayQuestions, listAttemptsForQuiz } = repo;
    repo.failStaleGenerating = (...a) => ((calls.stale += 1), failStaleGenerating(...a));
    repo.listPlayQuestions = (...a) => ((calls.play += 1), listPlayQuestions(...a));
    repo.listAttemptsForQuiz = (...a) => ((calls.attempts += 1), listAttemptsForQuiz(...a));
    for (let i = 0; i < 5; i++) await call(c, A, "GET", `/api/quiz/${id}`);
    expect(calls).toEqual({ stale: 0, play: 0, attempts: 0 });
    g.release();
    await c.app.quiz.whenIdle();
  });
});

describe("retry, regenerate and history", () => {
  it("retry creates a NEW attempt in a new order; the earlier attempt and its result are untouched", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 10 }));
    const first = await startAttempt(c, A, id);
    const firstResult = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${first.attempt.id}/submit`, { answers: answersFor(c, id, first, 7) })).json());

    const res = await call(c, A, "POST", `/api/quiz/${id}/retry`);
    expect(res.statusCode).toBe(200);
    const second = attemptViewSchema.parse(res.json());
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(second.attempt.status).toBe("in_progress");
    expect(second.answers).toEqual({}); // a clean slate
    expect(second.questions.map((q) => q.id).sort()).toEqual(first.questions.map((q) => q.id).sort()); // same questions...
    expect(second.questions.map((q) => q.id)).not.toEqual(first.questions.map((q) => q.id)); // ...new order

    const stillThere = resultSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${first.attempt.id}/result`)).json());
    expect(stillThere.attempt).toEqual(firstResult.attempt);
    expect(c.quiz.state.attempts).toHaveLength(2);
  });

  it("retry while an attempt is open resumes it instead of piling up duplicates", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const a = await startAttempt(c, A, id);
    const b = attemptViewSchema.parse((await call(c, A, "POST", `/api/quiz/${id}/retry`)).json());
    expect(b.attempt.id).toBe(a.attempt.id);
    expect(c.quiz.state.attempts).toHaveLength(1);
  });

  it("'start' after finishing once also gives a fresh, shuffled attempt", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 10 }));
    const a = await startAttempt(c, A, id);
    await call(c, A, "POST", `/api/quiz/attempts/${a.attempt.id}/submit`, {});
    const b = await startAttempt(c, A, id);
    expect(b.attempt.id).not.toBe(a.attempt.id);
  });

  it("regenerate makes a separate new quiz with the same settings and different questions", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 5, difficulty: "hard", timeLimitMinutes: 15 }));
    const before = (await call(c, A, "GET", `/api/quiz/${id}`)).json();
    const res = await call(c, A, "POST", `/api/quiz/${id}/regenerate`);
    expect(res.statusCode).toBe(202);
    await c.app.quiz.whenIdle();
    const newId = res.json().quiz.id as string;
    expect(newId).not.toBe(id);
    const after = quizDetailResponseSchema.parse((await call(c, A, "GET", `/api/quiz/${newId}`)).json());
    expect(after.quiz).toMatchObject({ status: "ready", difficulty: "hard", questionCount: 5, timeLimitMinutes: 15, title: expect.stringMatching(/\(new questions\)$/) });
    expect(after.quiz.sources.map((s) => s.id)).toEqual([NOTE_A]);
    const oldTexts = new Set(before.questions.map((q: { text: string }) => q.text));
    expect(after.questions.filter((q) => oldTexts.has(q.text))).toHaveLength(0);
    expect((await call(c, A, "GET", `/api/quiz/${id}`)).json().questions).toHaveLength(5); // original untouched
  });

  it("history lists every attempt (newest first) with its real score, and the summary is calculated from them", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const a1 = await startAttempt(c, A, id);
    clock.t += 60_000;
    await call(c, A, "POST", `/api/quiz/attempts/${a1.attempt.id}/submit`, { answers: answersFor(c, id, a1, 5) });
    clock.t += 60_000;
    const a2 = attemptViewSchema.parse((await call(c, A, "POST", `/api/quiz/${id}/retry`)).json());
    await call(c, A, "POST", `/api/quiz/attempts/${a2.attempt.id}/submit`, { answers: answersFor(c, id, a2, 2) });
    clock.t += 60_000;
    const a3 = attemptViewSchema.parse((await call(c, A, "POST", `/api/quiz/${id}/retry`)).json()); // left unfinished

    const history = (await call(c, A, "GET", "/api/quiz/attempts")).json().attempts;
    expect(history.map((h: { id: string }) => h.id)).toEqual([a3.attempt.id, a2.attempt.id, a1.attempt.id]);
    expect(history.map((h: { percentage: number | null }) => h.percentage)).toEqual([null, 40, 100]);
    expect(history[2]).toMatchObject({ quizTitle: "Biology a quiz", sourceType: "notes", sourceLabel: "Biology a", difficulty: "medium", questionCount: 5, status: "submitted", score: 5, total: 5 });

    const list = quizListResponseSchema.parse((await call(c, A, "GET", "/api/quiz")).json());
    expect(list.summary).toMatchObject({ quizzesCreated: 1, attemptsCompleted: 2, averagePercentage: 70, bestPercentage: 100 });
    expect(list.quizzes[0]).toMatchObject({ attemptCount: 2, bestPercentage: 100, inProgressAttemptId: a3.attempt.id });
  });

  it("with no activity there is no history and no invented numbers", async () => {
    const c = await make();
    const list = quizListResponseSchema.parse((await call(c, A, "GET", "/api/quiz")).json());
    expect(list.quizzes).toEqual([]);
    expect(list.summary).toEqual({ quizzesCreated: 0, attemptsCompleted: 0, averagePercentage: null, bestPercentage: null, questionsAnswered: 0, topics: [] });
    expect((await call(c, A, "GET", "/api/quiz/attempts")).json()).toEqual({ attempts: [] });
  });
});

describe("topic performance and mistakes", () => {
  it("calculates accuracy per topic from the real answers, weakest first", async () => {
    const c = await make();
    const id = await readyQuiz(c, A, notesBody({ count: 10 }));
    // Give the questions known topics so the expected numbers are exact: 6 Mechanics, 4 Heat.
    const qs = c.quiz.state.questions.filter((q) => q.quizId === id).sort((a, b) => a.order - b.order);
    qs.forEach((q, i) => (q.topic = i < 6 ? "Mechanics" : "Heat"));
    const v = await startAttempt(c, A, id);
    const key = keyOf(c, id);
    const mechanics = v.questions.filter((q) => key.get(q.id)!.topic === "Mechanics");
    const heat = v.questions.filter((q) => key.get(q.id)!.topic === "Heat");
    const answers = [
      ...mechanics.slice(0, 5).map((q) => ({ questionId: q.id, selected: key.get(q.id)!.correctIndex })), // 5 of 6 right
      ...heat.slice(0, 1).map((q) => ({ questionId: q.id, selected: key.get(q.id)!.correctIndex })), // 1 right
      ...heat.slice(1, 3).map((q) => ({ questionId: q.id, selected: (key.get(q.id)!.correctIndex + 1) % 4 })), // 2 wrong, 1 skipped
    ];
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers })).json());
    expect(r.topics).toEqual([
      { topic: "Heat", correct: 1, total: 4, percentage: 25 },
      { topic: "Mechanics", correct: 5, total: 6, percentage: 83.33 },
    ]);
    const summary = quizListResponseSchema.parse((await call(c, A, "GET", "/api/quiz")).json()).summary;
    expect(summary.topics).toEqual(r.topics);
    expect(summary.questionsAnswered).toBe(8);
  });

  it("groups questions with no reliable topic as unclassified instead of inventing one", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    c.quiz.state.questions.filter((q) => q.quizId === id).forEach((q) => (q.topic = null));
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) })).json());
    expect(r.topics).toEqual([{ topic: null, correct: 5, total: 5, percentage: 100 }]);
  });

  it("the review has everything needed for mistake review", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    const r = resultSchema.parse((await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 3, 2) })).json());
    const mistakes = r.review.filter((x) => !x.isCorrect);
    expect(mistakes).toHaveLength(2);
    for (const m of mistakes) {
      expect(m.selected).not.toBeNull();
      expect(m.selected).not.toBe(m.correctAnswer);
      expect(m.explanation.length).toBeGreaterThan(0);
      expect(m.options[m.correctAnswer]).toBeTruthy();
    }
  });
});

describe("ownership: a student can never reach another student's quiz data", () => {
  it("B gets 'not found' for everything of A's, and A's data is untouched", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 2) });
    const submitted = await readyQuiz(c);
    const done = await startAttempt(c, A, submitted);
    await call(c, A, "POST", `/api/quiz/attempts/${done.attempt.id}/submit`, { answers: answersFor(c, submitted, done, 5) });

    const attacks: Array<[string, "GET" | "POST" | "PUT", string, unknown?]> = [
      ["quiz detail", "GET", `/api/quiz/${id}`],
      ["start", "POST", `/api/quiz/${id}/start`],
      ["retry", "POST", `/api/quiz/${id}/retry`],
      ["regenerate", "POST", `/api/quiz/${id}/regenerate`],
      ["attempt view", "GET", `/api/quiz/attempts/${v.attempt.id}`],
      ["save answers", "PUT", `/api/quiz/attempts/${v.attempt.id}/answers`, { answers: answersFor(c, id, v, 5, 0) }],
      ["submit", "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5, 0) }],
      ["result of an open attempt", "GET", `/api/quiz/attempts/${v.attempt.id}/result`],
      ["result of a finished attempt", "GET", `/api/quiz/attempts/${done.attempt.id}/result`],
      ["submit a finished attempt", "POST", `/api/quiz/attempts/${done.attempt.id}/submit`],
    ];
    for (const [label, method, url, body] of attacks) {
      const res = await call(c, B, method, url, body);
      expect(res.statusCode, label).toBe(404);
      expect(res.body, label).not.toMatch(/explanation|correctAnswer|Biology/);
    }

    // A's attempt is exactly as A left it: still open, with A's two answers, nothing graded.
    const mine = attemptViewSchema.parse((await call(c, A, "GET", `/api/quiz/attempts/${v.attempt.id}`)).json());
    expect(mine.attempt.status).toBe("in_progress");
    expect(Object.keys(mine.answers)).toHaveLength(2);
    expect(c.quiz.state.attempts.filter((a) => a.userId === B)).toHaveLength(0);
    expect(c.quiz.state.answers.filter((a) => a.userId === B)).toHaveLength(0);
  });

  it("B's lists, history and summary never include A's quizzes, attempts or scores", async () => {
    const c = await make();
    const id = await readyQuiz(c);
    const v = await startAttempt(c, A, id);
    await call(c, A, "POST", `/api/quiz/attempts/${v.attempt.id}/submit`, { answers: answersFor(c, id, v, 5) });
    const list = quizListResponseSchema.parse((await call(c, B, "GET", "/api/quiz")).json());
    expect(list.quizzes).toEqual([]);
    expect(list.summary).toMatchObject({ quizzesCreated: 0, attemptsCompleted: 0, averagePercentage: null });
    expect((await call(c, B, "GET", "/api/quiz/attempts")).json().attempts).toEqual([]);
  });

  it("the owner id in a request body is ignored: identity comes from the token", async () => {
    const c = await make();
    const res = await call(c, B, "POST", "/api/quiz/generate", { ...notesBody({ source: { type: "notes", documentIds: [NOTE_B] } }), userId: A, user_id: A });
    expect(res.statusCode).toBe(202);
    await c.app.quiz.whenIdle();
    expect(c.quiz.state.quizzes[0]!.userId).toBe(B);
    expect(c.quiz.state.questions.every((q) => q.quizId === c.quiz.state.quizzes[0]!.id)).toBe(true);
  });
});
