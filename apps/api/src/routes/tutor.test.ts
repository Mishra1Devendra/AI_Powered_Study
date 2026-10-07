import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { AIError } from "../services/ai/errors.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tokens: Record<string, { id: string; email: string }> = {
  tokenA: { id: A, email: "a@example.com" },
  tokenB: { id: B, email: "b@example.com" },
};
const verifyToken = async (t: string) => tokens[t] ?? null;
const env = loadEnv({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SUPABASE_URL: "https://example.supabase.co",
  NODE_ENV: "test",
});
const db = {} as unknown as Database;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Parses the SSE body into validated events. */
function parseSse(body: string): TutorStreamEvent[] {
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));
}

async function make(ai: LLMProvider = new MockProvider(0)) {
  const store = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const app = await buildApp({ env, db, ai, verifyToken, tutorRepo: store.repo });
  return { app, ...store };
}

describe("tutor routes: authentication and validation", () => {
  let app: FastifyInstance;
  let convId: string;
  beforeAll(async () => {
    ({ app } = await make());
    const res = await app.inject({ method: "POST", url: "/api/tutor/conversations", headers: auth("tokenA"), payload: {} });
    convId = res.json().conversation.id;
  });
  afterAll(() => app.close());

  it.each([
    ["POST", "/api/tutor/conversations"],
    ["GET", "/api/tutor/conversations"],
    ["GET", "/api/tutor/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["PATCH", "/api/tutor/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["DELETE", "/api/tutor/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["POST", "/api/tutor/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/messages"],
    ["POST", "/api/tutor/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/regenerate"],
  ])("%s %s requires a valid token", async (method, url) => {
    for (const headers of [{}, auth("bogus")]) {
      const res = await app.inject({ method: method as "GET", url, headers, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
  });

  it.each([
    ["empty message", { content: "" }],
    ["whitespace-only message", { content: "   \n  " }],
    ["missing content", {}],
    ["non-string content", { content: 42 }],
    ["unknown mode", { content: "hi", mode: "cheat" }],
  ])("rejects %s with 400 before any AI call", async (_label, payload) => {
    const res = await app.inject({ method: "POST", url: `/api/tutor/conversations/${convId}/messages`, headers: auth("tokenA"), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
  });

  it("rejects an over-long message gracefully with a clear message", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tutor/conversations/${convId}/messages`,
      headers: auth("tokenA"),
      payload: { content: "x".repeat(4001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at most 4000 characters/);
  });

  it("rejects a huge request body with 413 and a safe message", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tutor/conversations/${convId}/messages`,
      headers: auth("tokenA"),
      payload: { content: "x".repeat(50_000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe("That request is too large.");
  });

  it.each(["not-a-uuid", "123", "00000000-0000-0000-0000-000000000000x"])("rejects invalid conversation id %s with 400", async (id) => {
    for (const [method, suffix] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/messages"], ["POST", "/regenerate"]] as const) {
      const res = await app.inject({
        method,
        url: `/api/tutor/conversations/${id}${suffix}`,
        headers: auth("tokenA"),
        payload: method === "GET" || method === "DELETE" ? undefined : { content: "hi" },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects invalid context values", async () => {
    const bad = [{ level: "expert" }, { subject: "x".repeat(81) }, { topic: "y".repeat(121) }];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/api/tutor/conversations", headers: auth("tokenA"), payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("tutor routes: conversation lifecycle", () => {
  it("create, list, get, send (SSE), reload, patch context, and soft-delete", async () => {
    const { app } = await make();
    const create = await app.inject({
      method: "POST",
      url: "/api/tutor/conversations",
      headers: auth("tokenA"),
      payload: { subject: "Physics", topic: " Thermodynamics ", level: "intermediate" },
    });
    expect(create.statusCode).toBe(201);
    const conv = create.json().conversation;
    expect(conv).toMatchObject({ subject: "Physics", topic: "Thermodynamics", level: "intermediate" });

    const send = await app.inject({
      method: "POST",
      url: `/api/tutor/conversations/${conv.id}/messages`,
      headers: auth("tokenA"),
      payload: { content: "What is entropy?", mode: "explain_simply" },
    });
    expect(send.statusCode).toBe(200);
    expect(send.headers["content-type"]).toContain("text/event-stream");
    expect(send.headers["cache-control"]).toBe("no-store");
    expect(send.headers["x-content-type-options"]).toBe("nosniff");
    const events = parseSse(send.body);
    expect(events.map((e) => e.type)[0]).toBe("user_message");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(1);

    // "Reload": a fresh GET returns the persisted history.
    const detail = await app.inject({ url: `/api/tutor/conversations/${conv.id}`, headers: auth("tokenA") });
    const body = detail.json();
    expect(body.conversation.title).toBe("What is entropy?");
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages[0]).toMatchObject({ mode: "explain_simply" });
    expect(body.messages[1]).toMatchObject({ isMock: true, model: "mock-demo" });
    expect(body.messages[1].content).toContain("Tutor mode seen by the provider: explain_simply");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tutor/conversations/${conv.id}`,
      headers: auth("tokenA"),
      payload: { topic: null, level: "advanced" },
    });
    expect(patch.json().conversation).toMatchObject({ subject: "Physics", topic: null, level: "advanced" });

    const list = await app.inject({ url: "/api/tutor/conversations", headers: auth("tokenA") });
    expect(list.json().conversations).toHaveLength(1);

    const del = await app.inject({ method: "DELETE", url: `/api/tutor/conversations/${conv.id}`, headers: auth("tokenA") });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: "/api/tutor/conversations", headers: auth("tokenA") })).json().conversations).toEqual([]);
    expect((await app.inject({ url: `/api/tutor/conversations/${conv.id}`, headers: auth("tokenA") })).statusCode).toBe(404);
    await app.close();
  });

  it("a failed generation arrives as an SSE error event, and retry answers the same message", async () => {
    let n = 0;
    const flaky: LLMProvider = {
      name: "mock",
      model: "flaky",
      isMock: true,
      async generateText() {
        throw new Error("unused");
      },
      async *streamText(): TextStream {
        if (++n === 1) throw new AIError("unavailable", "The AI service is temporarily unavailable.", true);
        yield "recovered";
        return {};
      },
    };
    const { app, msgs } = await make(flaky);
    const { conversation } = (await app.inject({ method: "POST", url: "/api/tutor/conversations", headers: auth("tokenA"), payload: {} })).json();

    const first = parseSse(
      (await app.inject({ method: "POST", url: `/api/tutor/conversations/${conversation.id}/messages`, headers: auth("tokenA"), payload: { content: "hello" } })).body,
    );
    expect(first.at(-1)).toMatchObject({ type: "error", code: "unavailable", retryable: true });

    const retry = parseSse(
      (await app.inject({ method: "POST", url: `/api/tutor/conversations/${conversation.id}/regenerate`, headers: auth("tokenA") })).body,
    );
    expect(retry.at(-1)).toMatchObject({ type: "done", message: { content: "recovered" } });
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    await app.close();
  });
});

describe("tutor routes: cross-user isolation", () => {
  it("student B gets 404 and no data for every operation on student A's conversation", async () => {
    const { app, msgs, convs } = await make();
    const { conversation } = (await app.inject({ method: "POST", url: "/api/tutor/conversations", headers: auth("tokenA"), payload: {} })).json();
    await app.inject({ method: "POST", url: `/api/tutor/conversations/${conversation.id}/messages`, headers: auth("tokenA"), payload: { content: "my secret question" } });
    const written = msgs.length;
    const u = `/api/tutor/conversations/${conversation.id}`;

    const results = await Promise.all([
      app.inject({ url: u, headers: auth("tokenB") }),
      app.inject({ method: "PATCH", url: u, headers: auth("tokenB"), payload: { title: "pwned" } }),
      app.inject({ method: "DELETE", url: u, headers: auth("tokenB") }),
      app.inject({ method: "POST", url: `${u}/messages`, headers: auth("tokenB"), payload: { content: "injected" } }),
      app.inject({ method: "POST", url: `${u}/regenerate`, headers: auth("tokenB") }),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("secret");
    }
    expect((await app.inject({ url: "/api/tutor/conversations", headers: auth("tokenB") })).json().conversations).toEqual([]);
    expect(msgs).toHaveLength(written);
    expect(convs.get(conversation.id)).toMatchObject({ title: "my secret question", deletedAt: null });
    await app.close();
  });
});

describe("tutor routes: rate limiting", () => {
  it("limits message generation per client and responds with a friendly 429", async () => {
    const { app } = await make();
    const { conversation } = (await app.inject({ method: "POST", url: "/api/tutor/conversations", headers: auth("tokenA"), payload: {} })).json();
    const statuses: number[] = [];
    let last = { message: "" };
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/tutor/conversations/${conversation.id}/messages`,
        headers: auth("tokenA"),
        payload: { content: `q${i}` },
      });
      statuses.push(res.statusCode);
      if (res.statusCode === 429) last = res.json();
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
    expect(last.message).toMatch(/Too many requests/);
    await app.close();
  });
});
