import { describe, expect, it } from "vitest";
import { tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { Database } from "./db/client.js";
import { createInMemoryNotesRepository } from "./notes/testing/memory.js";
import { createInMemoryPlannerRepository } from "./planner/testing/memory.js";
import { createInMemoryProgressRepository } from "./progress/testing/memory.js";
import { createInMemoryQuizRepository } from "./quiz/testing/memory.js";
import { createInMemoryExtrasRepository } from "./recommendations/testing/memory.js";
import { AIError } from "./services/ai/errors.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "./services/ai/types.js";
import { createInMemoryTutorRepository } from "./tutor/testing.js";
import { createInMemoryVivaRepository } from "./viva/testing/memory.js";

/**
 * AI OUTPUT ROBUSTNESS (Phase 13). A local model is still untrusted: it returns broken JSON, nothing, essays, or the wrong shape.
 * The SAME set of bad replies is thrown at every feature that asks for structured output, through the real routes, and each must
 * (a) end calmly with a student-safe message, (b) save nothing half-made, (c) stay within its documented call budget, and
 * (d) never leak anything technical.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const verifyToken = async (t: string) => (t === "token" ? { id: A, email: "a@example.com" } : null);
const headers = { authorization: "Bearer token" };
const TECHNICAL = /ECONNREFUSED|stack|node:internal|undefined|\[object|SyntaxError|Unexpected token|JSON\.parse|at\s+\S+\s+\(|\.ts:\d+/i;

const BAD_REPLIES: Array<[string, string]> = [
  ["an empty reply", ""],
  ["only whitespace", "   \n\t  "],
  ["plain prose, no JSON", "Sure! Here are some great questions about the topic. I hope that helps you study."],
  ["truncated JSON", '{"questions":[{"type":"mcq","text":"What is'],
  ["an unterminated array", '[{"id":1},'],
  ["an empty array", "[]"],
  ["an empty object", "{}"],
  ["the literal null", "null"],
  ["a bare number", "42"],
  ["a bare string", '"hello"'],
  ["objects with the wrong fields", '{"questions":[{"foo":"bar"},{"question":123}],"items":[{"id":5}],"sessions":[{"x":1}]}'],
  ["control characters", "\u0000\u0001\u0002\ufffd\ufffd"],
  ["Markdown with a code fence and no JSON", "```python\nprint('hi')\n```"],
  ["an enormous reply (300,000 characters)", "a".repeat(300_000)],
  ["JSON with the keys repeated and nonsense values", '{"questions":null,"questions":"x","questions":{"a":[1,2,3]}}'],
];

function scripted(reply: string | ((req: GenerateTextRequest, n: number) => string)): LLMProvider & { calls: number } {
  const p = {
    name: "ollama" as const,
    model: "scripted",
    isMock: false,
    calls: 0,
    async generateText(req: GenerateTextRequest) {
      p.calls++;
      return { text: typeof reply === "function" ? reply(req, p.calls) : reply, provider: "ollama" as const, model: "scripted", isMock: false };
    },
    async *streamText(req: GenerateTextRequest): TextStream {
      p.calls++;
      yield typeof reply === "function" ? reply(req, p.calls) : reply;
      return {};
    },
  };
  return p;
}

async function make(ai: LLMProvider) {
  const tutor = createInMemoryTutorRepository({ [A]: "Alice" });
  const notes = createInMemoryNotesRepository(tutor);
  const quiz = createInMemoryQuizRepository(notes.repo);
  const planner = createInMemoryPlannerRepository();
  const viva = createInMemoryVivaRepository();
  const progress = createInMemoryProgressRepository();
  const extras = createInMemoryExtrasRepository();
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({ env, db, ai, verifyToken, tutorRepo: tutor.repo, notesRepo: notes.repo, quizRepo: quiz.repo, plannerRepo: planner.repo, vivaRepo: viva.repo, progressRepo: progress.repo, extrasRepo: extras.repo });
  let n = 0;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers, remoteAddress: `10.5.0.${++n}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, call, tutor, quiz, planner, viva, progress };
}

const examDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const planBody = { title: "Boards", examDate, targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", subjects: [{ name: "Physics", priority: "high", topics: ["Optics"] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" };

describe.each(BAD_REPLIES)("when the model replies with %s", (_label, reply) => {
  it("quiz: the quiz fails calmly, nothing is saved, and the call budget holds", async () => {
    const ai = scripted(reply);
    const c = await make(ai);
    const res = await c.call("POST", "/api/quiz/generate", { source: { type: "topic", subject: "Physics", topic: "Optics" }, difficulty: "easy", count: 5, questionTypes: ["mcq"], timeLimitMinutes: null });
    expect(res.statusCode).toBe(202);
    await c.app.quiz.whenIdle();
    const quiz = (await c.call("GET", `/api/quiz/${res.json().quiz.id}`)).json().quiz;
    expect(quiz.status).toBe("failed");
    expect(typeof quiz.error).toBe("string");
    expect(quiz.error).not.toMatch(TECHNICAL);
    expect(c.quiz.state.questions.filter((q) => q.quizId === quiz.id)).toHaveLength(0); // nothing half-made
    expect(ai.calls).toBeLessThanOrEqual(5 + 2); // one per batch of five plus at most two top-ups (documented in quiz/generate.ts)
    expect(ai.calls).toBeGreaterThan(0);
  });

  it("study plan: the plan fails calmly with ONE call, and no session is saved", async () => {
    const ai = scripted(reply);
    const c = await make(ai);
    const res = await c.call("POST", "/api/study-plans/generate", planBody);
    expect(res.statusCode).toBe(202);
    await c.app.planner.whenIdle();
    const detail = (await c.call("GET", `/api/study-plans/${res.json().plan.id}`)).json();
    // Either the plan is usable (the app falls back to the student's own topics) or it failed with a safe message - never half-saved.
    if (detail.plan.status === "failed") {
      expect(detail.plan.error).not.toMatch(TECHNICAL);
      expect(detail.sessions).toHaveLength(0);
    } else {
      expect(detail.plan.status).toBe("active");
      expect(detail.sessions.length).toBeGreaterThan(0);
      expect(detail.sessions.every((s: { subject: string }) => s.subject === "Physics")).toBe(true); // only the student's own subject
    }
    expect(ai.calls).toBe(1); // documented: exactly ONE call per plan, no retry
  });

  it("viva: the question is refused with a calm 502 after at most two calls, and no viva is created", async () => {
    const ai = scripted(reply);
    const c = await make(ai);
    const res = await c.call("POST", "/api/viva/sessions", { subject: "Physics", topic: "Optics", difficulty: "easy", questionCount: 3 });
    if (res.statusCode === 201) {
      // a reply that happens to be a valid question is a legitimate success - but then it must be a well-formed question
      expect(res.json().questions[0].text.length).toBeGreaterThan(5);
      return;
    }
    expect([502, 504]).toContain(res.statusCode);
    expect(res.json().message).not.toMatch(TECHNICAL);
    expect(c.viva.sessions).toHaveLength(0);
    expect(ai.calls).toBeLessThanOrEqual(2); // first try + one retry, never more (viva/ai.ts)
  });

  it("recommendation explanation: always a normal answer (never an error page), at most one call", async () => {
    const ai = scripted(reply);
    const c = await make(ai);
    c.progress.addAttempt(A, { title: "Q", subject: "Physics", submittedAt: new Date(Date.now() - 86_400_000), startedAt: new Date(Date.now() - 90_000_000), questions: Array.from({ length: 5 }, () => ({ topic: "Optics", result: false as const })) });
    const res = await c.call("POST", "/api/recommendations/explain", {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (!body.available) expect(body.message).toMatch(/temporarily unavailable|nothing to explain/i);
    expect(JSON.stringify(body)).not.toMatch(TECHNICAL);
    expect(ai.calls).toBeLessThanOrEqual(1);
  });
});

describe("tutor streaming with a misbehaving model", () => {
  const parse = (body: string): TutorStreamEvent[] =>
    body
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));
  const ask = async (ai: LLMProvider) => {
    const c = await make(ai);
    const conv = (await c.call("POST", "/api/tutor/conversations", {})).json().conversation.id;
    const res = await c.call("POST", `/api/tutor/conversations/${conv}/messages`, { content: "Explain refraction." });
    return { events: parse(res.body), stored: c.tutor.msgs.filter((m) => m.conversationId === conv), c, conv };
  };

  it("an empty reply is a typed, retryable error - and no empty assistant message is saved", async () => {
    const { events, stored } = await ask(scripted(""));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "empty_response", retryable: true });
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });

  it("an absurdly long reply (300,000 characters) is refused instead of being stored or streamed forever", async () => {
    const { events, stored } = await ask(scripted("a".repeat(300_000)));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });

  it("a second message sent while the first is still being answered is refused with a calm 409, and the first still completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: LLMProvider = {
      name: "ollama",
      model: "slow",
      isMock: false,
      generateText: async () => Promise.reject(new Error("unused")),
      async *streamText(): TextStream {
        await gate;
        yield "Finally answered.";
        return {};
      },
    };
    const c = await make(slow);
    const conv = (await c.call("POST", "/api/tutor/conversations", {})).json().conversation.id;
    const first = c.call("POST", `/api/tutor/conversations/${conv}/messages`, { content: "Explain refraction." });
    await new Promise((r) => setTimeout(r, 50));
    const second = await c.call("POST", `/api/tutor/conversations/${conv}/messages`, { content: "Explain it again." });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).not.toMatch(TECHNICAL);
    release();
    expect(parse((await first).body).at(-1)).toMatchObject({ type: "done" });
    expect(c.tutor.msgs.filter((m) => m.conversationId === conv && m.role === "user")).toHaveLength(1); // the refused message was not saved
  });

  it("odd Markdown (unclosed fences, raw HTML, huge tables) is just text: it is stored and shown, never executed", async () => {
    const odd = "```js\nalert(1)\n<script>alert('x')</script>\n| a | b |\n|---|\n$$ \\frac{1";
    const { events, stored } = await ask(scripted(odd));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(stored.at(-1)!.content).toBe(odd); // verbatim; the web renderer escapes it (react-markdown does not render raw HTML)
  });

  it("a provider that fails mid-stream becomes a typed error event; the student's message stays saved", async () => {
    const flaky: LLMProvider = {
      name: "ollama",
      model: "x",
      isMock: false,
      generateText: async () => Promise.reject(new Error("unused")),
      async *streamText(): TextStream {
        yield "Part of an answer";
        throw new AIError("unavailable", "Lost the connection to the local AI.", true);
      },
    };
    const { events, stored } = await ask(flaky);
    expect(events.map((e) => e.type)).toEqual(["user_message", "delta", "error"]);
    expect(events.at(-1)).toMatchObject({ code: "unavailable", retryable: true });
    expect(stored.map((m) => m.role)).toEqual(["user"]); // the half answer is NOT saved as if it were complete
  });

  it("an unexpected exception inside the provider is reported as a generic message, never its text", async () => {
    const broken: LLMProvider = {
      name: "ollama",
      model: "x",
      isMock: false,
      generateText: async () => Promise.reject(new Error("unused")),
      // eslint-disable-next-line require-yield
      async *streamText(): TextStream {
        throw new TypeError("Cannot read properties of undefined (reading 'secret') at C:\\internal\\path\\file.ts:12");
      },
    };
    const { events } = await ask(broken);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "error", code: "internal" });
    expect(JSON.stringify(last)).not.toMatch(/secret|internal\\path|file\.ts/);
  });
});
