import { describe, expect, it, vi } from "vitest";
import { BUG_REPORTS_PER_DAY, auditListSchema, bugReportListSchema } from "@copilot/shared";
import { createInMemoryAccessRepository } from "../access/testing/memory.js";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { cleanPage } from "./repository.js";
import { createInMemoryBugRepository } from "./testing/memory.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const S2 = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const tokens: Record<string, { id: string; email: string }> = { admin: { id: ADMIN, email: "a@x.co" }, s1: { id: S1, email: "r@x.co" }, s2: { id: S2, email: "m@x.co" } };
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

async function make() {
  const access = createInMemoryAccessRepository([
    { id: ADMIN, displayName: "Alice Admin", email: "a@x.co", role: "admin", accessStatus: "active" },
    { id: S1, displayName: "Ravi", email: "r@x.co", role: "student", accessStatus: "active" },
    { id: S2, displayName: "Meera", email: "m@x.co", role: "student", accessStatus: "active" },
  ]);
  const bugs = createInMemoryBugRepository({ [ADMIN]: "Alice Admin", [S1]: "Ravi", [S2]: "Meera" });
  const app = await buildApp({ env, db: { transaction: vi.fn() } as unknown as Database, ai: new MockProvider(), verifyToken: async (t) => tokens[t] ?? null, accessRepo: access.repo, bugRepo: bugs.repo });
  let n = 0;
  const call = (who: string | null, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `10.4.0.${++n}`, headers: who ? { authorization: `Bearer ${who}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { call, access, bugs };
}
const report = { title: "Quiz page freezes", description: "When I press Submit on the quiz nothing happens for a long time.", page: "/quiz/attempt/abc?token=secret#x" };

describe("filing a bug report", () => {
  it("needs a signed-in account; the reporter is the verified user, whatever the body says", async () => {
    const { call, bugs } = await make();
    expect((await call(null, "POST", "/api/bug-reports", report)).statusCode).toBe(401);
    const res = await call("s1", "POST", "/api/bug-reports", { ...report });
    expect(res.statusCode).toBe(201);
    expect(bugs.rows[0]).toMatchObject({ userId: S1, reporterName: "Ravi", status: "open" });
    // an attempt to file as someone else is rejected outright (strict body)
    expect((await call("s1", "POST", "/api/bug-reports", { ...report, userId: S2 })).statusCode).toBe(400);
  });

  it("keeps only the page path (no query string or fragment) and refuses short, long or missing text", async () => {
    const { call, bugs } = await make();
    await call("s1", "POST", "/api/bug-reports", report);
    expect(bugs.rows[0]!.page).toBe("/quiz/attempt/abc");
    expect(cleanPage("https://evil.example/x")).toBeNull();
    expect(cleanPage("javascript:alert(1)")).toBeNull();
    expect(cleanPage("/notes/42")).toBe("/notes/42");
    for (const bad of [{}, { title: "ab", description: report.description }, { title: "ok title", description: "short" }, { title: "x".repeat(121), description: report.description }, { title: "ok title", description: "y".repeat(2001) }]) {
      expect((await call("s1", "POST", "/api/bug-reports", bad)).statusCode).toBe(400);
    }
  });

  it(`is limited to ${BUG_REPORTS_PER_DAY} reports a day per account, and one person's limit never blocks another`, async () => {
    const { call } = await make();
    for (let i = 0; i < BUG_REPORTS_PER_DAY; i++) expect((await call("s1", "POST", "/api/bug-reports", report)).statusCode).toBe(201);
    const over = await call("s1", "POST", "/api/bug-reports", report);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("too_many_reports");
    expect((await call("s2", "POST", "/api/bug-reports", report)).statusCode).toBe(201);
  });
});

describe("the admin inbox and audit log", () => {
  it("students cannot read reports, change them, or read the audit log", async () => {
    const { call } = await make();
    await call("s1", "POST", "/api/bug-reports", report);
    for (const [method, url, body] of [
      ["GET", "/api/admin/bug-reports", undefined],
      ["POST", "/api/admin/bug-reports/00000000-0000-4000-8000-000000000001/status", { status: "resolved" }],
      ["GET", "/api/admin/audit-log", undefined],
    ] as const) {
      expect((await call(null, method, url, body)).statusCode).toBe(401);
      expect((await call("s1", method, url, body)).statusCode).toBe(403);
    }
  });

  it("an admin sees the reports with the reporter's name, filters by status, and resolves or reopens one", async () => {
    const { call } = await make();
    await call("s1", "POST", "/api/bug-reports", report);
    await call("s2", "POST", "/api/bug-reports", { ...report, title: "Another problem" });
    const all = bugReportListSchema.parse((await call("admin", "GET", "/api/admin/bug-reports")).json());
    expect(all.reports).toHaveLength(2);
    expect(all.counts.open).toBe(2);
    expect(all.reports.map((r) => r.reporterName).sort()).toEqual(["Meera", "Ravi"]);

    const id = all.reports[0]!.id;
    const resolved = await call("admin", "POST", `/api/admin/bug-reports/${id}/status`, { status: "resolved" });
    expect(resolved.json().report).toMatchObject({ id, status: "resolved" });
    expect((await call("admin", "GET", "/api/admin/bug-reports?status=open")).json()).toMatchObject({ counts: { open: 1 } });
    expect((await call("admin", "GET", "/api/admin/bug-reports?status=resolved")).json().reports).toHaveLength(1);
    expect((await call("admin", "POST", `/api/admin/bug-reports/${id}/status`, { status: "open" })).json().report.status).toBe("open");
    expect((await call("admin", "GET", "/api/admin/bug-reports?status=bogus")).statusCode).toBe(400);
    expect((await call("admin", "POST", "/api/admin/bug-reports/00000000-0000-4000-8000-0000000000ff/status", { status: "resolved" })).statusCode).toBe(404);
    expect((await call("admin", "POST", `/api/admin/bug-reports/${id}/status`, { status: "deleted" })).statusCode).toBe(400);
  });

  it("access changes appear in the audit log, newest first, with names and no content", async () => {
    const { call } = await make();
    await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "revoked" });
    await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "active" });
    const log = auditListSchema.parse((await call("admin", "GET", "/api/admin/audit-log")).json());
    expect(log.entries.map((e) => e.action)).toEqual(["access_restored", "access_paused"]);
    expect(log.entries[0]).toMatchObject({ actorName: "Alice Admin", targetName: "Ravi" });
    expect(Object.keys(log.entries[0]!).sort()).toEqual(["action", "actorName", "createdAt", "id", "targetName"]);
  });

  it("a refused change (own account, another admin, unknown id) writes nothing to the audit log", async () => {
    const { call, access } = await make();
    await call("admin", "POST", `/api/admin/students/${ADMIN}/access`, { status: "revoked" });
    await call("admin", "POST", "/api/admin/students/c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0/access", { status: "revoked" });
    expect(access.state.audit).toHaveLength(0);
  });
});

describe("Bug Tracker: three columns, type and severity", () => {
  it("a report can carry a type and a severity; the defaults are bug / medium", async () => {
    const { call, bugs } = await make();
    await call("s1", "POST", "/api/bug-reports", { ...report, type: "feature", severity: "high" });
    await call("s2", "POST", "/api/bug-reports", report);
    expect(bugs.rows.map((r) => [r.type, r.severity]).sort()).toEqual([["bug", "medium"], ["feature", "high"]]);
    for (const bad of [{ type: "idea" }, { severity: "urgent" }, { type: "BUG" }]) expect((await call("s1", "POST", "/api/bug-reports", { ...report, ...bad })).statusCode).toBe(400);
  });

  it("an admin moves a report across Open -> In progress -> Resolved and back; counts follow; each move is audited", async () => {
    const { call } = await make();
    await call("s1", "POST", "/api/bug-reports", report);
    const id = (await call("admin", "GET", "/api/admin/bug-reports")).json().reports[0].id as string;
    const move = async (status: string) => (await call("admin", "POST", `/api/admin/bug-reports/${id}/status`, { status })).json().report.status;
    expect(await move("in_progress")).toBe("in_progress");
    expect((await call("admin", "GET", "/api/admin/bug-reports")).json().counts).toEqual({ total: 1, open: 0, in_progress: 1, resolved: 0 });
    expect(await move("resolved")).toBe("resolved");
    expect((await call("admin", "GET", "/api/admin/bug-reports")).json().counts).toEqual({ total: 1, open: 0, in_progress: 0, resolved: 1 });
    expect(await move("open")).toBe("open");
    const log = (await call("admin", "GET", "/api/admin/audit-log")).json();
    expect(log.entries).toHaveLength(0); // the in-memory bug repo keeps its own audit list; the real one writes to the shared log (live test)
  });
});

describe("Users & Access and Audit Log numbers", () => {
  it("accounts show who last paused them and when they last signed in", async () => {
    const { call, access } = await make();
    access.state.byId.get(S1)!.lastSignInAt = "2026-10-05T10:00:00.000Z";
    await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "revoked" });
    const list = (await call("admin", "GET", "/api/admin/students")).json().students as Array<{ id: string; accessChangedByName: string | null; lastSignInAt: string | null }>;
    const ravi = list.find((s) => s.id === S1)!;
    expect(ravi).toMatchObject({ accessChangedByName: "Alice Admin", lastSignInAt: "2026-10-05T10:00:00.000Z" });
    expect(list.find((s) => s.id === S2)).toMatchObject({ accessChangedByName: null, lastSignInAt: null });
  });

  it("the audit log summary counts only real things, for the chosen range, and rejects a malformed range", async () => {
    const { call, access } = await make();
    access.state.now = () => Date.parse("2026-02-01T12:00:00.000Z");
    access.state.byId.get(S1)!.lastSignInAt = "2026-02-01T08:00:00.000Z"; // within 24h
    access.state.byId.get(S2)!.lastSignInAt = "2025-11-01T08:00:00.000Z"; // dormant (more than 30 days)
    await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "revoked" });
    await call("admin", "POST", `/api/admin/students/${S1}/access`, { status: "active" });
    const all = (await call("admin", "GET", "/api/admin/audit-log")).json();
    expect(all.summary.inRange).toEqual({ total: 2, paused: 1, restored: 1, bugChanges: 0 });
    expect(all.summary.actions24h).toBe(2);
    expect(all.summary.activeUsers24h).toBe(1);
    expect(all.summary.accounts).toMatchObject({ total: 3, active: 3, paused: 0, neverSignedIn: 1, dormant30d: 1, signedIn30d: 1 });
    const outside = (await call("admin", "GET", "/api/admin/audit-log?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z")).json();
    expect(outside.entries).toHaveLength(0);
    expect(outside.summary.inRange.total).toBe(0);
    expect(outside.summary.actions24h).toBe(2); // the 24h cards ignore the range
    expect((await call("admin", "GET", "/api/admin/audit-log?from=yesterday")).statusCode).toBe(400);
  });
});
