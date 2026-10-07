import { describe, expect, it } from "vitest";
import { NOT_IN_NOTES_MESSAGE, recommendationsResponseSchema, tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryKnowledgeRepository } from "../knowledge/testing/memory.js";
import { createFakeStorage, createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { createInMemoryProgressRepository } from "../progress/testing/memory.js";
import { createInMemoryQuizRepository } from "../quiz/testing/memory.js";
import { createInMemoryExtrasRepository } from "../recommendations/testing/memory.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";
import { createInMemoryVivaRepository } from "../viva/testing/memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const NOW = new Date(Date.UTC(2026, 9, 15, 12));

const BIOLOGY = `# Biology Basics

## Photosynthesis

Photosynthesis is the process by which plants convert light energy into chemical energy stored in glucose. It takes place in the chloroplasts, which contain chlorophyll. ${"The light reactions capture energy and the Calvin cycle uses it to build sugars. ".repeat(6)}
`;

function recorder() {
  const requests: GenerateTextRequest[] = [];
  const ai: LLMProvider = {
    name: "ollama",
    model: "scripted",
    isMock: false,
    async generateText(req) {
      requests.push(req);
      return { text: "{}", provider: "ollama", model: "scripted", isMock: false };
    },
    async *streamText(req): TextStream {
      requests.push(req);
      yield "In the chloroplasts [S1].";
      return {};
    },
  };
  return { ai, requests };
}

async function make() {
  const { ai, requests } = recorder();
  const tutor = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutor);
  const quiz = createInMemoryQuizRepository(notes.repo);
  const progress = createInMemoryProgressRepository();
  const extras = createInMemoryExtrasRepository();
  const viva = createInMemoryVivaRepository();
  const fake = createFakeStorage();
  const db = { transaction: async () => [{ displayName: "Alice", timezone: "UTC" }] } as unknown as Database;
  const app = await buildApp({
    env, db, ai, verifyToken,
    tutorRepo: tutor.repo,
    notesRepo: notes.repo,
    notesStorage: fake.storage,
    knowledgeRepo: createInMemoryKnowledgeRepository(notes),
    quizRepo: quiz.repo,
    progressRepo: progress.repo,
    progressNow: () => NOW,
    extrasRepo: extras.repo,
    vivaRepo: viva.repo,
  });
  return { app, requests, progress };
}
type Ctx = Awaited<ReturnType<typeof make>>;

async function uploadText(c: Ctx, who: string, text = BIOLOGY): Promise<string> {
  const res = await c.app.inject({ method: "POST", url: "/api/notes/text", headers: bearer(who), payload: { text, title: "Biology.pdf" } });
  expect(res.statusCode).toBe(201);
  return res.json().note.id as string;
}
const sse = (body: string): TutorStreamEvent[] =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));
async function conversation(c: Ctx, who: string) {
  const res = await c.app.inject({ method: "POST", url: "/api/tutor/conversations", headers: bearer(who), payload: {} });
  return res.json().conversation.id as string;
}
const send = (c: Ctx, who: string, convId: string, payload: object) => c.app.inject({ method: "POST", url: `/api/tutor/conversations/${convId}/messages`, headers: bearer(who), payload });

describe("tutor route: asking about a document", () => {
  it("validates documentId / grounding before anything is saved or generated", async () => {
    const c = await make();
    const conv = await conversation(c, A);
    for (const payload of [{ content: "hi", documentId: "nope" }, { content: "hi", documentId: 12 }, { content: "hi", grounding: "paid" }, { content: "hi", documentId: "1 or 1=1" }]) {
      const res = await send(c, A, conv, payload);
      expect(res.statusCode).toBe(400);
    }
    expect(c.requests).toHaveLength(0);
  });

  it("another student's document is a 404 and nothing is generated", async () => {
    const c = await make();
    const doc = await uploadText(c, A);
    const conv = await conversation(c, B);
    const res = await send(c, B, conv, { content: "What is photosynthesis?", documentId: doc });
    expect(res.statusCode).toBe(404);
    expect(c.requests).toHaveLength(0);
  });

  it("answers from the student's document with sources, and says so when the topic is not in it", async () => {
    const c = await make();
    const doc = await uploadText(c, A);
    const conv = await conversation(c, A);
    const hit = sse((await send(c, A, conv, { content: "Where does photosynthesis happen in the chloroplasts?", documentId: doc })).body);
    const done = hit.find((e) => e.type === "done");
    expect(done).toMatchObject({ type: "done", message: { grounding: "grounded" } });
    expect(done?.type === "done" && done.message.sources?.[0]?.documentId).toBe(doc);
    expect(c.requests).toHaveLength(1);

    const miss = sse((await send(c, A, conv, { content: "What is the Carnot efficiency of a heat engine?", documentId: doc })).body);
    expect(miss.find((e) => e.type === "done")).toMatchObject({ message: { content: NOT_IN_NOTES_MESSAGE, grounding: "not_found" } });
    expect(c.requests).toHaveLength(1); // no second model call
  });
});

describe("notes route: index status", () => {
  it("requires a token, validates the id, hides other students' documents, and reports the real state", async () => {
    const c = await make();
    const doc = await uploadText(c, A);
    expect((await c.app.inject({ method: "GET", url: `/api/notes/${doc}/index-status` })).statusCode).toBe(401);
    expect((await c.app.inject({ method: "GET", url: "/api/notes/not-a-uuid/index-status", headers: bearer(A) })).statusCode).toBe(400);
    expect((await c.app.inject({ method: "GET", url: `/api/notes/${doc}/index-status`, headers: bearer(B) })).statusCode).toBe(404);
    const res = await c.app.inject({ method: "GET", url: `/api/notes/${doc}/index-status`, headers: bearer(A) });
    expect(res.statusCode).toBe(200);
    expect(res.json().index).toMatchObject({ documentId: doc, state: "indexed", method: "keyword", embeddings: false });
    expect(res.json().index.chunkCount).toBeGreaterThan(0);
  });
});

describe("viva routes: sources", () => {
  const start = (c: Ctx, who: string, payload: object) => c.app.inject({ method: "POST", url: "/api/viva/sessions", headers: bearer(who), payload: { subject: "Biology", difficulty: "easy", questionCount: 3, ...payload } });

  it("validates the source before any AI call", async () => {
    const c = await make();
    expect((await start(c, A, { sourceType: "cloud" })).statusCode).toBe(400);
    expect((await start(c, A, { sourceType: "document" })).statusCode).toBe(400); // needs a document
    expect((await start(c, A, { sourceType: "document", documentId: "nope" })).statusCode).toBe(400);
    expect(c.requests).toHaveLength(0);
  });

  it("another student's document is a 404; no notes at all is a clear 422 - neither calls the AI", async () => {
    const c = await make();
    const doc = await uploadText(c, A);
    expect((await start(c, B, { sourceType: "document", documentId: doc })).statusCode).toBe(404);
    const none = await start(c, B, { sourceType: "notes", topic: "photosynthesis" });
    expect(none.statusCode).toBe(422);
    expect(none.json()).toMatchObject({ error: "no_material", message: "I couldn't find relevant information in this material." });
    expect(c.requests).toHaveLength(0);
  });
});

describe("recommendations: notes action", () => {
  const q = (topic: string, result: boolean, n = 1) => Array.from({ length: n }, () => ({ topic, result }));
  const at = (daysAgo: number) => new Date(Date.UTC(2026, 9, 15 - daysAgo, 10));

  it("offers 'Review notes' only where the student's own document really covers the topic - never invented", async () => {
    const c = await make();
    const doc = await uploadText(c, A);
    for (const who of [A, B]) {
      c.progress.addAttempt(who, { title: "Bio 1", subject: "Biology", submittedAt: at(2), startedAt: at(2), questions: [...q("Photosynthesis", false, 5), ...q("Roman History", false, 5)] });
    }
    const list = async (who: string) => recommendationsResponseSchema.parse((await c.app.inject({ method: "GET", url: "/api/recommendations", headers: bearer(who) })).json());

    const mine = await list(A);
    const photo = mine.recommendations.find((r) => r.topic === "Photosynthesis")!;
    const roman = mine.recommendations.find((r) => r.topic === "Roman History")!;
    expect(photo.actions.find((a) => a.kind === "notes")).toMatchObject({ label: "Review notes", documentId: doc });
    expect(photo.actions.some((a) => a.kind === "tutor")).toBe(true); // "Ask Tutor" is still there
    expect(roman.actions.some((a) => a.kind === "notes")).toBe(false); // no document covers it: nothing invented

    const theirs = await list(B);
    expect(theirs.recommendations.every((r) => r.actions.every((a) => a.kind !== "notes"))).toBe(true); // B has no documents
  });
});
