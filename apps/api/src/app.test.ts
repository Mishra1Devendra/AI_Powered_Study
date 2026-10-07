import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { Database } from "./db/client.js";
import { MockProvider } from "./services/ai/mock-provider.js";

const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const failingDb = { execute: () => Promise.reject(new Error("connect ECONNREFUSED secret-host")) } as unknown as Database;
const workingDb = { execute: () => Promise.resolve([]) } as unknown as Database;

describe("health routes", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env, db: workingDb, ai: new MockProvider(), verifyToken: async () => null });
  });
  afterAll(() => app.close());

  it("GET /api/health reports the mock AI provider", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", ai: { provider: "mock", isMock: true } });
  });

  it("GET /api/health/ready is ok when the database answers", async () => {
    const res = await app.inject({ url: "/api/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().database.ok).toBe(true);
  });

  it("reports 503 degraded without leaking driver details when the database is down", async () => {
    const down = await buildApp({ env, db: failingDb, ai: new MockProvider(), verifyToken: async () => null });
    const res = await down.inject({ url: "/api/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("degraded");
    expect(res.body).not.toContain("secret-host");
    await down.close();
  });
});
