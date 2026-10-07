import { describe, expect, it, vi } from "vitest";
import { ACCESS_REVOKED_MESSAGE, adminStudentListSchema } from "@copilot/shared";
import { buildApp, resolveAccessRepo } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { likePattern } from "./repository.js";
import { createInMemoryAccessRepository, type MemoryAccount } from "./testing/memory.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const S1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const S2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const GHOST = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const tokens: Record<string, { id: string; email: string }> = {
  admin: { id: ADMIN, email: "admin@example.com" },
  admin2: { id: ADMIN2, email: "admin2@example.com" },
  s1: { id: S1, email: "ravi@gmail.com" },
  s2: { id: S2, email: "meera@gmail.com" },
};
const accounts = (): MemoryAccount[] => [
  { id: ADMIN, displayName: "Alice Admin", email: "admin@example.com", role: "admin", accessStatus: "active" },
  { id: ADMIN2, displayName: "Second Admin", email: "admin2@example.com", role: "admin", accessStatus: "active" },
  { id: S1, displayName: "Ravi", email: "ravi@gmail.com", role: "student", accessStatus: "active" },
  { id: S2, displayName: "Meera", email: "meera@gmail.com", role: "student", accessStatus: "active" },
];
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });
const verifyToken = async (t: string) => tokens[t] ?? null;

async function make(list: MemoryAccount[] = accounts()) {
  const mem = createInMemoryAccessRepository(list);
  const transaction = vi.fn(async () => [{ id: S1, displayName: "Ravi", timezone: "UTC", role: "student" }]);
  const app = await buildApp({ env, db: { transaction } as unknown as Database, ai: new MockProvider(), verifyToken, accessRepo: mem.repo });
  let n = 0;
  const call = (who: string | null, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, remoteAddress: `10.7.0.${++n}`, headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, call, mem, transaction };
}

describe("admin routes: who may use them", () => {
  it("need a signed-in user (401), and a student gets 403 on every admin route", async () => {
    const { call } = await make();
    for (const [method, url, body] of [
      ["GET", "/api/admin/students", undefined],
      ["POST", `/api/admin/students/${S2}/access`, { status: "revoked" }],
    ] as const) {
      expect((await call(null, method, url, body)).statusCode).toBe(401);
      expect((await call("bad-token", method, url, body)).statusCode).toBe(401);
      const asStudent = await call("s1", method, url, body);
      expect(asStudent.statusCode).toBe(403);
      expect(asStudent.json().error).toBe("forbidden");
    }
  });

  it("cannot be unlocked by claiming to be an admin: role headers, body fields and query strings are ignored", async () => {
    const { call, mem } = await make();
    for (const h of [{ "x-user-role": "admin" }, { "x-role": "admin" }, { role: "admin" }] as Array<Record<string, string>>) {
      expect((await call("s1", "GET", "/api/admin/students?role=admin&admin=true", undefined, h)).statusCode).toBe(403);
    }
    expect((await call("s1", "POST", `/api/admin/students/${S2}/access`, { status: "revoked", role: "admin" })).statusCode).toBe(403);
    expect(mem.state.byId.get(S2)!.accessStatus).toBe("active"); // nothing changed
  });

  it("an admin may list accounts, with their role and status, and never any study content", async () => {
    const { call } = await make();
    const res = await call("admin", "GET", "/api/admin/students");
    expect(res.statusCode).toBe(200);
    const data = adminStudentListSchema.parse(res.json());
    expect(data.total).toBe(4);
    expect(data.truncated).toBe(false);
    expect(data.students.map((s) => s.role).sort()).toEqual(["admin", "admin", "student", "student"]);
    expect(Object.keys(data.students[0]!).sort()).toEqual(["accessChangedAt", "accessChangedByName", "accessStatus", "createdAt", "displayName", "email", "id", "lastSignInAt", "role"]);
  });

  it("search filters by name or Gmail address; a long or wildcard-only query is handled safely", async () => {
    const { call } = await make();
    expect((await call("admin", "GET", "/api/admin/students?q=meera")).json().students.map((s: { id: string }) => s.id)).toEqual([S2]);
    expect((await call("admin", "GET", "/api/admin/students?q=ravi%40gmail")).json().total).toBe(1);
    expect((await call("admin", "GET", `/api/admin/students?q=${"x".repeat(200)}`)).statusCode).toBe(400);
    expect((await call("admin", "GET", "/api/admin/students?q=%25")).statusCode).toBe(200);
  });
});

describe("pausing and restoring a student's access", () => {
  it("a paused student is refused at once with a calm 403; restoring lets them straight back in", async () => {
    const { call, transaction } = await make();
    expect((await call("s1", "GET", "/api/me")).statusCode).toBe(200);

    const paused = await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "revoked" });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().student).toMatchObject({ id: S1, accessStatus: "revoked" });

    transaction.mockClear();
    const blocked = await call("s1", "GET", "/api/me");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: "access_revoked", message: ACCESS_REVOKED_MESSAGE });
    expect(transaction).not.toHaveBeenCalled(); // refused BEFORE any data is touched
    expect((await call("s1", "GET", "/api/admin/students")).statusCode).toBe(403);

    expect((await call("s2", "GET", "/api/me")).statusCode).toBe(200); // other students are unaffected

    const restored = await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "active" });
    expect(restored.json().student).toMatchObject({ accessStatus: "active" });
    expect((await call("s1", "GET", "/api/me")).statusCode).toBe(200);
  });

  it("an admin cannot pause themselves or another admin, and unknown or malformed ids are refused", async () => {
    const { call, mem } = await make();
    expect((await call("admin", "POST", `/api/admin/students/${ADMIN}/access`, { status: "revoked" })).statusCode).toBe(400);
    const other = await call("admin", "POST", `/api/admin/students/${ADMIN2}/access`, { status: "revoked" });
    expect(other.statusCode).toBe(403);
    expect(mem.state.byId.get(ADMIN2)!.accessStatus).toBe("active");
    expect((await call("admin", "POST", `/api/admin/students/${GHOST}/access`, { status: "revoked" })).statusCode).toBe(404);
    expect((await call("admin", "POST", "/api/admin/students/not-a-uuid/access", { status: "revoked" })).statusCode).toBe(400);
  });

  it.each([
    ["an unknown status", { status: "deleted" }],
    ["no status", {}],
    ["extra fields (the role cannot be set here)", { status: "revoked", role: "admin" }],
    ["an array instead of an object", ["revoked"]],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const { call, mem } = await make();
    const res = await call("admin", "POST", `/api/admin/students/${S1}/access`, body);
    expect(res.statusCode).toBe(400);
    expect(mem.state.byId.get(S1)!.accessStatus).toBe("active");
    expect(mem.state.byId.get(S1)!.role).toBe("student");
  });

  it("records who changed access and when", async () => {
    const { call, mem } = await make();
    await call("admin", "POST", `/api/admin/students/${S2}/access`, { status: "revoked" });
    expect(mem.state.byId.get(S2)).toMatchObject({ accessChangedBy: ADMIN, accessStatus: "revoked" });
    expect(mem.state.byId.get(S2)!.accessChangedAt).not.toBeNull();
  });
});

describe("the access check itself", () => {
  it("runs on every authenticated request (not cached per session)", async () => {
    const { call, mem } = await make();
    await call("s1", "GET", "/api/me");
    await call("s1", "GET", "/api/me");
    await call("s1", "GET", "/api/me");
    expect(mem.state.lookups).toBe(3);
  });

  it("fails closed: if the account cannot be looked up, the request is an error, never a pass", async () => {
    const { app, mem } = await make();
    mem.repo.get = async () => {
      throw new Error("db down");
    };
    const res = await app.inject({ url: "/api/me", headers: { authorization: "Bearer s1" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/db down/);
  });

  it("an account with no profile row is treated as an ordinary student, never an admin", async () => {
    const { call } = await make([]);
    expect((await call("admin", "GET", "/api/admin/students")).statusCode).toBe(403);
  });

  it("is on by default outside tests, off only in NODE_ENV=test unless injected", () => {
    const db = {} as Database;
    expect(resolveAccessRepo({ NODE_ENV: "test" }, db)).toBeUndefined();
    expect(resolveAccessRepo({ NODE_ENV: "production" }, db)).toBeDefined();
    expect(resolveAccessRepo({ NODE_ENV: "development" }, db)).toBeDefined();
    const injected = createInMemoryAccessRepository([]).repo;
    expect(resolveAccessRepo({ NODE_ENV: "test" }, db, injected)).toBe(injected);
  });

  it("escapes search wildcards", () => {
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});
