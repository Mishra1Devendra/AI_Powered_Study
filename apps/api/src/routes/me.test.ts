import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SUPABASE_URL: "https://example.supabase.co",
  NODE_ENV: "test",
});
const transaction = vi.fn();
const db = { transaction } as unknown as Database;
const verifyToken = async (t: string) => (t === "good" ? { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co" } : null);

describe("protected /api/me routes", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env, db, ai: new MockProvider(), verifyToken });
  });
  afterAll(() => app.close());

  it.each([
    ["no Authorization header", undefined],
    ["a non-bearer scheme", "Basic abc"],
    ["an invalid token", "Bearer bad"],
    ["an empty bearer", "Bearer "],
  ])("GET /api/me returns 401 with %s", async (_label, authorization) => {
    const res = await app.inject({ url: "/api/me", headers: authorization ? { authorization } : {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("PATCH /api/me/profile returns 401 without a valid token", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/me/profile", payload: { displayName: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["empty body", {}],
    ["blank name", { displayName: "   " }],
    ["over-long name", { displayName: "x".repeat(81) }],
    ["bad timezone", { timezone: "Mars/Olympus" }],
  ])("PATCH rejects %s with 400 before touching the database", async (_label, payload) => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { authorization: "Bearer good" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("ignores any client-supplied id: the identity comes only from the token", async () => {
    transaction.mockImplementation(async () => []);
    const res = await app.inject({
      url: "/api/me?id=99999999-9999-4999-8999-999999999999",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(404); // empty result from the (mocked) DB; no id parameter is consulted
  });
});
