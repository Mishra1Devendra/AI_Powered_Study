import { describe, expect, it, vi } from "vitest";
import { deckDetailResponseSchema, deckListResponseSchema, mindmapResponseSchema, studyQueueResponseSchema } from "@copilot/shared";
import { buildApp, type BuiltApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createInMemoryStudyToolsRepository } from "../study-tools/memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING = "99999999-9999-4999-8999-999999999999";
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const tokens: Record<string, { id: string; email: string }> = { a: { id: A, email: "a@x.co" }, b: { id: B, email: "b@x.co" } };

async function make() {
  const store = createInMemoryStudyToolsRepository();
  const app: BuiltApp = await buildApp({ env, db: { transaction: vi.fn(), execute: vi.fn() } as unknown as Database, ai: new MockProvider(0), verifyToken: async (t) => tokens[t] ?? null, studyToolsRepo: store.repo });
  let n = 0;
  const call = (who: string | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), remoteAddress: `10.9.0.${++n}`, headers: who ? { authorization: `Bearer ${who}` } : {} });
  return { app, call, store };
}

const topicDeck = { source: { type: "topic", subject: "Biology" }, count: 5 };

describe("flashcard and mind map routes", () => {
  it("every route needs a signed-in student", async () => {
    const { call } = await make();
    for (const [method, url] of [
      ["GET", "/api/flashcards/decks"],
      ["POST", "/api/flashcards/decks/generate"],
      ["POST", "/api/flashcards/decks"],
      ["GET", `/api/flashcards/decks/${MISSING}`],
      ["GET", `/api/flashcards/decks/${MISSING}/study`],
      ["POST", `/api/flashcards/cards/${MISSING}/review`],
      ["DELETE", `/api/flashcards/cards/${MISSING}`],
      ["POST", "/api/mindmaps/generate"],
      ["GET", "/api/mindmaps"],
      ["GET", `/api/mindmaps/${MISSING}`],
      ["POST", `/api/mindmaps/${MISSING}/regenerate`],
    ] as const) {
      expect((await call(null, method, url, {})).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("generate -> poll -> study -> review, end to end", async () => {
    const { app, call } = await make();
    const started = await call("a", "POST", "/api/flashcards/decks/generate", topicDeck);
    expect(started.statusCode).toBe(202);
    const id = started.json().deck.id as string;
    await app.studyTools!.idle();

    const detail = deckDetailResponseSchema.parse((await call("a", "GET", `/api/flashcards/decks/${id}`)).json());
    expect(detail.deck).toMatchObject({ status: "ready", cardCount: 5 });

    const round = studyQueueResponseSchema.parse((await call("a", "GET", `/api/flashcards/decks/${id}/study`)).json());
    expect(round.cards).toHaveLength(5);
    // The answer side is part of the card (it is the student's own study material), but scheduling data comes only from the server.
    const reviewed = await call("a", "POST", `/api/flashcards/cards/${round.cards[0]!.id}/review`, { grade: "good" });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().card).toMatchObject({ state: "review", intervalDays: 1 });

    const list = deckListResponseSchema.parse((await call("a", "GET", "/api/flashcards/decks")).json());
    expect(list).toMatchObject({ reviewedToday: 1 });
    expect(list.decks[0]).toMatchObject({ newCount: 4 });
  });

  it("rejects bad input with 400 and never trusts a client-supplied schedule, owner or id", async () => {
    const { app, call } = await make();
    expect((await call("a", "POST", "/api/flashcards/decks/generate", { source: { type: "topic", subject: "" }, count: 5 })).statusCode).toBe(400);
    expect((await call("a", "POST", "/api/flashcards/decks/generate", { ...topicDeck, count: 500 })).statusCode).toBe(400);
    expect((await call("a", "POST", "/api/flashcards/decks/generate", { ...topicDeck, userId: B })).statusCode).toBe(400);
    expect((await call("a", "POST", "/api/flashcards/decks", { title: "  " })).statusCode).toBe(400);
    const deck = (await call("a", "POST", "/api/flashcards/decks", { title: "Mine" })).json().deck;
    expect((await call("a", "POST", `/api/flashcards/decks/${deck.id}/cards`, { front: "q", back: "" })).statusCode).toBe(400);
    const card = (await call("a", "POST", `/api/flashcards/decks/${deck.id}/cards`, { front: "Q?", back: "A" })).json().card;
    expect((await call("a", "POST", `/api/flashcards/cards/${card.id}/review`, { grade: "perfect" })).statusCode).toBe(400);
    expect((await call("a", "POST", `/api/flashcards/cards/${card.id}/review`, { grade: "good", intervalDays: 9999, dueAt: "2030-01-01" })).statusCode).toBe(400);
    expect((await call("a", "PATCH", `/api/flashcards/cards/${card.id}`, { dueAt: "2030-01-01" })).statusCode).toBe(400);
    expect((await call("a", "PATCH", `/api/flashcards/cards/${card.id}`, {})).statusCode).toBe(400);
    expect((await call("a", "GET", "/api/flashcards/decks/not-a-uuid")).statusCode).toBe(400);
    await app.studyTools!.idle();
  });

  it("one student cannot see or touch another's deck, cards or mind maps (404)", async () => {
    const { call, app } = await make();
    const deck = (await call("a", "POST", "/api/flashcards/decks", { title: "Private" })).json().deck;
    const card = (await call("a", "POST", `/api/flashcards/decks/${deck.id}/cards`, { front: "Secret?", back: "Yes" })).json().card;
    const map = (await call("a", "POST", "/api/mindmaps/generate", { source: { type: "topic", subject: "Private" }, size: "small" })).json().mindmap;
    await app.studyTools!.idle();

    const attempts: Array<[Parameters<typeof call>[1], string, unknown?]> = [
      ["GET", `/api/flashcards/decks/${deck.id}`],
      ["PATCH", `/api/flashcards/decks/${deck.id}`, { title: "mine now" }],
      ["DELETE", `/api/flashcards/decks/${deck.id}`],
      ["GET", `/api/flashcards/decks/${deck.id}/study`],
      ["POST", `/api/flashcards/decks/${deck.id}/cards`, { front: "x", back: "y" }],
      ["PATCH", `/api/flashcards/cards/${card.id}`, { front: "hacked" }],
      ["DELETE", `/api/flashcards/cards/${card.id}`],
      ["POST", `/api/flashcards/cards/${card.id}/review`, { grade: "easy" }],
      ["GET", `/api/mindmaps/${map.id}`],
      ["PATCH", `/api/mindmaps/${map.id}`, { title: "mine now" }],
      ["DELETE", `/api/mindmaps/${map.id}`],
      ["POST", `/api/mindmaps/${map.id}/regenerate`],
    ];
    for (const [method, url, body] of attempts) expect((await call("b", method, url, body ?? {})).statusCode, `${method} ${url}`).toBe(404);
    expect(deckListResponseSchema.parse((await call("b", "GET", "/api/flashcards/decks")).json()).decks).toEqual([]);
    expect((await call("b", "GET", "/api/mindmaps")).json().mindmaps).toEqual([]);
    // ... and the owner's data is untouched.
    expect((await call("a", "GET", `/api/flashcards/decks/${deck.id}`)).json().cards[0].front).toBe("Secret?");
  });

  it("mind map: generate -> poll -> rename -> regenerate -> delete", async () => {
    const { app, call } = await make();
    const started = await call("a", "POST", "/api/mindmaps/generate", { source: { type: "topic", subject: "Cells" }, size: "medium" });
    expect(started.statusCode).toBe(202);
    const id = started.json().mindmap.id as string;
    await app.studyTools!.idle();
    const got = mindmapResponseSchema.parse((await call("a", "GET", `/api/mindmaps/${id}`)).json()).mindmap;
    expect(got).toMatchObject({ status: "ready", isMock: true });
    expect(got.tree?.children.length).toBeGreaterThanOrEqual(2);
    expect((await call("a", "PATCH", `/api/mindmaps/${id}`, { title: "Cell map" })).json().mindmap.title).toBe("Cell map");
    expect((await call("a", "POST", `/api/mindmaps/${id}/regenerate`)).statusCode).toBe(202);
    await app.studyTools!.idle();
    expect((await call("a", "GET", "/api/mindmaps")).json().mindmaps).toHaveLength(2);
    expect((await call("a", "DELETE", `/api/mindmaps/${id}`)).statusCode).toBe(204);
    expect((await call("a", "GET", `/api/mindmaps/${id}`)).statusCode).toBe(404);
  });

  it("generation is rate limited per client", async () => {
    const { app, call } = await make();
    const codes: number[] = [];
    // Same address each time so the limiter sees one client.
    for (let i = 0; i < 8; i++) codes.push((await app.inject({ method: "POST", url: "/api/mindmaps/generate", payload: { source: { type: "topic", subject: "X" }, size: "small" }, remoteAddress: "10.77.0.1", headers: { authorization: "Bearer a" } })).statusCode);
    expect(codes).toContain(429);
    await app.studyTools!.idle();
    void call;
  });
});
