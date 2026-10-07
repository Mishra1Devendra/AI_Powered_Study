import { describe, expect, it } from "vitest";
import { explainResponseSchema, recommendationsResponseSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryProgressRepository } from "../progress/testing/memory.js";
import { createInMemoryExtrasRepository } from "../recommendations/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { AIError } from "../services/ai/errors.js";
import { OllamaOrMockProvider } from "../services/ai/mock-fallback.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { OllamaProvider } from "../services/ai/ollama-provider.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

/** Thursday 15 October 2026, 12:00 UTC. */
const NOW = new Date(Date.UTC(2026, 9, 15, 12));
const at = (daysAgo: number, hour = 10) => new Date(Date.UTC(2026, 9, 15 - daysAgo, hour));

type Reply = string | Error | ((system: string) => string);
/** A scripted provider that records what it is asked. */
function scripted(replies: Reply[], opts: { mock?: boolean } = {}) {
  const requests: GenerateTextRequest[] = [];
  const ai: LLMProvider = {
    name: opts.mock ? "mock" : "ollama",
    model: "scripted-model",
    isMock: opts.mock ?? false,
    async generateText(req) {
      requests.push(req);
      const next = replies.shift();
      if (next === undefined) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return { text: typeof next === "function" ? next(req.system ?? "") : next, provider: ai.name, model: ai.model, isMock: ai.isMock };
    },
    // eslint-disable-next-line require-yield
    async *streamText(): TextStream {
      throw new Error("not used");
    },
  };
  return { ai, requests };
}
const idsOf = (system: string) => (JSON.parse(/RECO_SPEC: ({.*})/.exec(system)![1]!) as { ids: string[] }).ids;
/** A good model answer: friendly text per id, using only numbers that are in the facts. */
const goodReply: Reply = (system) => JSON.stringify({ overview: "Start with your weakest topic, then keep the others warm.", items: idsOf(system).map((id) => ({ id, text: `This one matters now, so start here: ${id.split(":")[1]}.` })) });

async function make(ai: LLMProvider = scripted([]).ai, opts: { deadline?: number } = {}) {
  const tutor = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutor);
  const quiz = createInMemoryQuizRepository(notes.repo);
  const progress = createInMemoryProgressRepository();
  const extras = createInMemoryExtrasRepository();
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({ env, db, ai, verifyToken, tutorRepo: tutor.repo, notesRepo: notes.repo, quizRepo: quiz.repo, progressRepo: progress.repo, progressNow: () => NOW, extrasRepo: extras.repo, ...(opts.deadline ? { explainDeadlineMs: opts.deadline } : {}) });
  return { app, progress, extras };
}
type Ctx = Awaited<ReturnType<typeof make>>;

const get = (c: Ctx, who: string | null, url = "/api/recommendations") => c.app.inject({ method: "GET", url, ...(who ? { headers: bearer(who) } : {}) });
const explain = (c: Ctx, who: string | null) => c.app.inject({ method: "POST", url: "/api/recommendations/explain", ...(who ? { headers: bearer(who) } : {}), payload: {} });
const list = async (c: Ctx, who: string, url?: string) => {
  const res = await get(c, who, url);
  expect(res.statusCode).toBe(200);
  return recommendationsResponseSchema.parse(res.json());
};
const q = (topic: string, result: boolean | "skipped", n = 1) => Array.from({ length: n }, () => ({ topic, result }));

/** A student with a weak topic (Electrostatics), a strong one (Waves), an improving one (Integration) and a plan. */
function seedA(c: Ctx) {
  c.progress.addAttempt(A, { title: "Physics 1", subject: "Physics", submittedAt: at(3), startedAt: at(3, 9), questions: [...q("Electrostatics", false, 4), ...q("Electrostatics", true, 1), ...q("Waves", true, 5)] });
  c.progress.addAttempt(A, { title: "Physics 2", subject: "Physics", submittedAt: at(1), startedAt: at(1, 9), questions: [...q("Electrostatics", false, 4), ...q("Electrostatics", true, 1), ...q("Waves", true, 4), ...q("Waves", false, 1)] });
  c.progress.addAttempt(A, { title: "Maths 1", subject: "Maths", submittedAt: at(12), startedAt: at(12, 9), questions: [...q("Integration", false, 3), ...q("Integration", true, 2)] });
  c.progress.addAttempt(A, { title: "Maths 2", subject: "Maths", submittedAt: at(2), startedAt: at(2, 9), questions: [...q("Integration", true, 4), ...q("Integration", false, 1)] });
  c.extras.addRepeated(A, { topic: "Electrostatics", subject: "Physics", questions: 2 });
  c.extras.addSource(A, { topic: "Electrostatics", documentId: "00000000-0000-4000-8000-0000000000d1", title: "Physics notes" });
  c.extras.setPlan(A, { examDate: "2026-11-20", minutesPerDay: 60 });
  c.progress.addSession(A, { date: "2026-10-16", status: "planned", subject: "Maths", topic: "Integration", activityType: "practice", durationMinutes: 30 });
}

describe("authentication and validation", () => {
  it.each([
    ["GET", "/api/recommendations"],
    ["POST", "/api/recommendations/explain"],
  ] as const)("%s %s requires a signed-in student and reads nothing", async (method, url) => {
    const s = scripted([goodReply]);
    const c = await make(s.ai);
    expect((await c.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
    expect((await c.app.inject({ method, url, payload: {}, headers: { authorization: "Bearer forged" } })).statusCode).toBe(401);
    expect(s.requests).toHaveLength(0);
    expect(c.progress.calls.load).toBe(0);
    expect(c.extras.calls.load).toBe(0);
  });

  it.each(["0", "31", "-1", "abc", "1.5", ""])("rejects limit=%j with 400 and reads nothing", async (limit) => {
    const c = await make();
    const res = await get(c, A, `/api/recommendations?limit=${encodeURIComponent(limit)}`);
    expect(res.statusCode).toBe(400);
    expect(c.progress.calls.load).toBe(0);
  });

  it("limits the number of recommendations, defaulting to 10", async () => {
    const c = await make();
    seedA(c);
    expect((await list(c, A, "/api/recommendations?limit=2")).recommendations).toHaveLength(2);
    expect((await list(c, A, "/api/recommendations?limit=1")).recommendations).toHaveLength(1);
    expect((await list(c, A)).recommendations.length).toBeLessThanOrEqual(10);
  });

  it("ignores any user id the client sends", async () => {
    const c = await make();
    seedA(c);
    for (const url of [`/api/recommendations?userId=${A}`, `/api/recommendations?user_id=${A}&limit=5`]) {
      const res = await c.app.inject({ method: "GET", url, headers: { ...bearer(B), "x-user-id": A } });
      expect(res.statusCode).toBe(200);
      expect(recommendationsResponseSchema.parse(res.json()).recommendations).toEqual([]);
    }
  });
});

describe("the recommendations", () => {
  it("come from the student's own data, ranked, with honest reasons", async () => {
    const c = await make();
    seedA(c);
    const r = await list(c, A);
    expect(r.today).toBe("2026-10-15");
    expect(r.summary).toEqual({ topicsAnalyzed: 3, topicsWithEnoughData: 3, hasEnoughData: true });
    const top = r.recommendations[0]!;
    expect(top).toMatchObject({ topic: "Electrostatics", subject: "Physics", type: "URGENT_REVISION", priority: "high", primary: "quiz" });
    expect(top.reason).toBe("You scored 20% across 10 questions in 2 quiz attempts. You got the same 2 questions wrong in more than one attempt.");
    const types = Object.fromEntries(r.recommendations.map((x) => [x.topic, x.type]));
    expect(types).toMatchObject({ Electrostatics: "URGENT_REVISION", Integration: "IMPROVING", Waves: "MAINTAIN_STRENGTH" });
    const improving = r.recommendations.find((x) => x.type === "IMPROVING")!;
    expect(improving.reason).toContain("improved from 40% to 80%");
    expect(r.recommendations.find((x) => x.type === "UPCOMING_STUDY")).toMatchObject({ title: "Continue: Integration", primary: "plan" });
    // Strongest topics come last.
    expect(r.recommendations.at(-1)!.type).toBe("MAINTAIN_STRENGTH");
  });

  it("connect to the existing Quiz, Tutor, Viva, Notes and Study Plan as data - and start nothing", async () => {
    const s = scripted([]);
    const c = await make(s.ai);
    seedA(c);
    const before = JSON.stringify([c.progress.calls, c.extras.calls]);
    const r = await list(c, A);
    const weak = r.recommendations.find((x) => x.topic === "Electrostatics")!;
    expect(weak.actions.map((a) => a.kind)).toEqual(["quiz", "tutor", "notes", "viva"]);
    expect(weak.actions[0]).toMatchObject({ kind: "quiz", subject: "Physics", topic: "Electrostatics", count: 5 });
    expect(weak.actions[1]).toMatchObject({ kind: "tutor", draft: "Explain the common mistakes I make in Electrostatics" });
    expect(weak.actions[2]).toMatchObject({ kind: "notes", documentId: "00000000-0000-4000-8000-0000000000d1" });
    expect(weak.actions[3]).toMatchObject({ kind: "viva", subject: "Physics", topic: "Electrostatics", count: 5 });
    const plan = r.recommendations.find((x) => x.type === "UPCOMING_STUDY")!;
    expect(plan.actions[0]).toMatchObject({ kind: "plan", sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // Nothing was started or generated: no AI call, and only the two reads happened.
    expect(s.requests).toHaveLength(0);
    expect(JSON.stringify([c.progress.calls, c.extras.calls])).not.toBe(before);
    expect(c.progress.calls.load).toBe(1);
    expect(c.extras.calls.load).toBe(1);
  });

  it("each student sees only their own recommendations", async () => {
    const c = await make();
    seedA(c);
    c.progress.addAttempt(B, { title: "Chem", subject: "Chemistry", submittedAt: at(2), startedAt: at(2, 9), questions: q("Bonding", false, 5) });
    const a = await list(c, A);
    const b = await list(c, B);
    expect(JSON.stringify(a)).not.toContain("Bonding");
    expect(b.recommendations.map((x) => x.topic)).toEqual(["Bonding"]);
    expect(JSON.stringify(b)).not.toMatch(/Electrostatics|Integration|Physics notes/);
  });

  it("uses vivas, the tutor and study sessions as real signals", async () => {
    const c = await make();
    c.progress.addAttempt(A, { subject: "Physics", submittedAt: at(25), startedAt: at(25, 9), questions: q("Heat", true, 3).concat(q("Heat", false, 2)) });
    c.progress.addViva(A, { subject: "Physics", topic: "Heat", score: 35, completedAt: at(2), dims: [3, 3, 4, 3] });
    c.extras.addTutor(A, { topic: "heat", subject: "Physics", date: "2026-10-13" });
    const rec = (await list(c, A)).recommendations.find((x) => x.topic === "Heat")!;
    expect(rec.facts).toMatchObject({ accuracy: 60, vivaAverage: 35, vivaSessions: 1, daysSincePracticed: 2 });
    expect(rec.reason).toContain("Your viva score on this topic is 35%.");
    expect(rec.type).toBe("PRACTICE_MORE");
  });

  it("works in the student's own timezone", async () => {
    const c = await make();
    c.progress.setTimezone(A, "Pacific/Kiritimati"); // UTC+14: it is already the 16th there
    c.progress.addAttempt(A, { subject: "Physics", submittedAt: new Date(Date.UTC(2026, 9, 15, 11)), startedAt: new Date(Date.UTC(2026, 9, 15, 10)), questions: q("Heat", false, 5) });
    const r = await list(c, A);
    expect(r.today).toBe("2026-10-16");
    expect(r.recommendations[0]!.facts.daysSincePracticed).toBe(0); // done on the 16th local time
  });

  it("an empty student gets an empty list and 'not enough data' - nothing invented", async () => {
    const c = await make();
    const r = await list(c, A);
    expect(r.recommendations).toEqual([]);
    expect(r.summary).toEqual({ topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false });
  });

  it("a student with only a few questions is asked for more practice, not called weak", async () => {
    const c = await make();
    c.progress.addAttempt(A, { subject: "Physics", submittedAt: at(1), startedAt: at(1, 9), questions: q("Optics", false, 2) });
    const r = await list(c, A);
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0]).toMatchObject({ type: "PRACTICE_MORE", priority: "low" });
    expect(r.recommendations[0]!.reason).toMatch(/too few/);
  });
});

describe("the optional AI explanation", () => {
  it("is NOT used by the page: listing makes no AI call", async () => {
    const s = scripted([goodReply]);
    const c = await make(s.ai);
    seedA(c);
    await list(c, A);
    await list(c, A, "/api/recommendations?limit=3");
    expect(s.requests).toHaveLength(0);
  });

  it("makes ONE call when asked, sends only the student's own calculated facts, and returns the friendly text", async () => {
    const s = scripted([goodReply]);
    const c = await make(s.ai);
    seedA(c);
    c.progress.addAttempt(B, { subject: "Chemistry", submittedAt: at(2), startedAt: at(2, 9), questions: q("Bonding", false, 5) });
    const res = await explain(c, A);
    expect(res.statusCode).toBe(200);
    const body = explainResponseSchema.parse(res.json());
    expect(s.requests).toHaveLength(1);
    expect(body).toMatchObject({ available: true, message: null, isMock: false, model: "scripted-model" });
    expect(body.overview).toContain("Start with your weakest topic");
    expect(body.items.length).toBeGreaterThan(0);
    const system = s.requests[0]!.system!;
    expect(system).toContain("Electrostatics");
    expect(system).toContain("2026-11-20"); // the real exam date
    expect(system).not.toContain("Bonding"); // another student's data never reaches the model
    expect(system).toContain("Do NOT invent or change any score");
    expect(s.requests[0]).toMatchObject({ json: true });
    // The facts in the prompt are the same ones the page shows.
    // The facts are plain lines (a small model copies JSON's shape): the same recommendations the page shows, with the app's own reasons.
    const shown = (await list(c, A, "/api/recommendations?limit=5")).recommendations;
    expect([...system.matchAll(/id: (\S+)/g)].map((m) => m[1])).toEqual(shown.map((x) => x.id));
    for (const r of shown) expect(system).toContain(r.reason);
    expect(system).toContain("Exam on 2026-11-20 (36 days left).");
    expect(system).toContain("study 60 minutes a day");
  });

  it("drops any text with a number that is not in the facts, and any id it was not given", async () => {
    const bad: Reply = (system) => {
      const ids = idsOf(system);
      return JSON.stringify({
        overview: "You are at 95% overall, great job and keep going.",
        items: [
          { id: ids[0]!, text: "You scored 77% here, so this is the place to start." }, // 77 is not a fact
          { id: ids[1]!, text: "Start with a short practice session on this one." }, // fine
          { id: "WEAK_TOPIC:made-up", text: "This topic does not exist in your data at all." }, // unknown id
          { id: ids[1]!, text: "A second text for the same recommendation should be ignored." },
        ],
      });
    };
    const c = await make(scripted([bad]).ai);
    seedA(c);
    const body = explainResponseSchema.parse((await explain(c, A)).json());
    expect(body.available).toBe(true);
    expect(body.overview).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.text).toBe("Start with a short practice session on this one.");
  });

  it("allows numbers that ARE in the facts (for example the real accuracy)", async () => {
    const c = await make(scripted([(system) => JSON.stringify({ overview: "Your 20% in the weakest topic is the priority.", items: [{ id: idsOf(system)[0]!, text: "You got 2 questions wrong more than once, so start here." }] })]).ai);
    seedA(c);
    const body = explainResponseSchema.parse((await explain(c, A)).json());
    expect(body.overview).toBe("Your 20% in the weakest topic is the priority.");
    expect(body.items).toHaveLength(1);
  });

  it("recovers good items from a reply whose JSON is broken around them (a small model's habit), still checking every one", async () => {
    const broken: Reply = (system) => {
      const [first, second] = idsOf(system);
      return `{"overview":"Start with the weakest topic and keep the rest warm.","items":[{"id":"${first}","text":"Start here: this is your biggest gap right now."},"items [{"  ],"items":[{"id":"${second}","text":"You scored 99% here, which is great."}] }`;
    };
    const c = await make(scripted([broken]).ai);
    seedA(c);
    const body = explainResponseSchema.parse((await explain(c, A)).json());
    expect(body.available).toBe(true);
    expect(body.overview).toBe("Start with the weakest topic and keep the rest warm.");
    expect(body.items).toHaveLength(1); // the second text invents a 99% and is dropped
    expect(body.items[0]!.text).toBe("Start here: this is your biggest gap right now.");
  });

  it.each([
    ["malformed JSON", "this is not json"],
    ["the wrong shape", JSON.stringify({ hello: "world" })],
    ["only unusable items", JSON.stringify({ overview: "", items: [{ id: "x", text: "nope nope nope nope" }] })],
  ])("%s: the page keeps working - available:false with a calm message, and NO retry", async (_l, reply) => {
    const s = scripted([reply, goodReply]);
    const c = await make(s.ai);
    seedA(c);
    const res = await explain(c, A);
    expect(res.statusCode).toBe(200);
    expect(explainResponseSchema.parse(res.json())).toMatchObject({ available: false, items: [], overview: null, message: "AI explanation is temporarily unavailable. Your recommendations are still available using your learning data." });
    expect(s.requests).toHaveLength(1);
    expect((await list(c, A)).recommendations.length).toBeGreaterThan(0);
  });

  it("a provider error or timeout is a normal 'not available' answer, never a retry", async () => {
    for (const err of [new AIError("timeout", "slow"), new AIError("local_unavailable", "down"), new AIError("unknown", "boom")]) {
      const s = scripted([err, goodReply]);
      const c = await make(s.ai);
      seedA(c);
      const res = await explain(c, A);
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(false);
      expect(s.requests).toHaveLength(1);
    }
  });

  it("a model that never answers is cut off by the deadline", async () => {
    const never: LLMProvider = {
      name: "ollama",
      model: "slow",
      isMock: false,
      generateText: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      // eslint-disable-next-line require-yield
      async *streamText(): TextStream {
        throw new Error("not used");
      },
    };
    const c = await make(never, { deadline: 30 });
    seedA(c);
    expect(explainResponseSchema.parse((await explain(c, A)).json()).available).toBe(false);
    // The guard was released: asking again works the same way.
    expect((await explain(c, A)).statusCode).toBe(200);
  });

  it("nothing to explain: no AI call", async () => {
    const s = scripted([goodReply]);
    const c = await make(s.ai);
    const body = explainResponseSchema.parse((await explain(c, A)).json());
    expect(body).toMatchObject({ available: false, message: "There is nothing to explain yet. Complete a few quizzes or study sessions first." });
    expect(s.requests).toHaveLength(0);
  });

  it("two explanations at once: one runs, the other gets 409 and no extra AI call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = scripted([() => "" as string]);
    const gated: LLMProvider = { ...s.ai, generateText: async (req) => (await gate, goodReplyFor(req)) };
    const goodReplyFor = (req: GenerateTextRequest) => ({ text: (goodReply as (s: string) => string)(req.system ?? ""), provider: "ollama" as const, model: "m", isMock: false });
    const c = await make(gated);
    seedA(c);
    const first = explain(c, A);
    await new Promise((r) => setTimeout(r, 20));
    const second = await explain(c, A);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("explain_busy");
    release();
    expect((await first).statusCode).toBe(200);
  });

  it("uses the offline Mock provider (clearly marked) when no local AI is running - never anything paid", async () => {
    const c = await make(new MockProvider(0));
    seedA(c);
    const body = explainResponseSchema.parse((await explain(c, A)).json());
    expect(body).toMatchObject({ available: true, isMock: true, model: "mock-demo" });
    expect(body.overview).toContain("[Demo]");
    expect(body.items.every((i) => i.text.startsWith("[Demo]"))).toBe(true);
  });

  it("falls back to Mock when Ollama is not running, and uses the local server (JSON mode) when it is", async () => {
    const down = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 1000, numCtx: 8192, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const c1 = await make(new OllamaOrMockProvider(down, 0));
    seedA(c1);
    expect(explainResponseSchema.parse((await explain(c1, A)).json())).toMatchObject({ available: true, isMock: true });

    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      bodies.push(JSON.parse(String(init.body)));
      const system = String((bodies.at(-1)!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "system")?.content ?? "");
      return new Response(JSON.stringify({ message: { content: (goodReply as (s: string) => string)(system) }, done: true }) + "\n", { status: 200 });
    }) as unknown as typeof fetch;
    const ollama = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b", timeoutMs: 5000, numCtx: 8192, fetchImpl });
    const c2 = await make(new OllamaOrMockProvider(ollama, 0));
    seedA(c2);
    const body = explainResponseSchema.parse((await explain(c2, A)).json());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ format: "json", model: "llama3.2:3b" });
    expect(body).toMatchObject({ available: true, isMock: false, model: "llama3.2:3b" });
  });
});
