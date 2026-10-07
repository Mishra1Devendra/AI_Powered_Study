import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createTokenVerifier } from "../auth/verify-token.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createBugRepository } from "../bugs/repository.js";
import { createAccessRepository } from "./repository.js";

/**
 * ROLES AND ACCESS against the real database (rolled back): the new columns, the check constraints, that a STUDENT can never
 * change their own role or access status (column-level grants), that other students' rows stay invisible, and the admin API on
 * top of the real repository.
 */
const ADMIN = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const S1 = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const S2 = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

describe.skipIf(!live)("roles and access (live DB, rolled back)", () => {
  it("students cannot grant themselves anything; admins can pause and restore students; paused students are refused", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test" });
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const tokenFor = (sub: string, email: string) =>
      new SignJWT({ sub, role: "authenticated", email })
        .setProtectedHeader({ alg: "ES256", kid: "k" })
        .setIssuer(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(pair.privateKey);

    await expect(
      db.transaction(async (tx) => {
        const make = (id: string, email: string, name: string) =>
          tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, ${JSON.stringify({ display_name: name })}::jsonb, now(), now())`);
        await make(ADMIN, "admin-role-test@invalid.test", "Role Admin");
        await make(S1, "student1-role-test@invalid.test", "Role Student One");
        await make(S2, "student2-role-test@invalid.test", "Role Student Two");
        const repo = createAccessRepository(tx as unknown as Database);
        const udb = tx as unknown as Database;
        const rejected = async (query: ReturnType<typeof sql>, message: RegExp) => {
          try {
            await tx.transaction(async (sp) => sp.execute(query));
          } catch (err) {
            const e = err as Error & { cause?: Error };
            expect(e.cause?.message ?? e.message).toMatch(message);
            return;
          }
          throw new Error("expected the statement to be rejected");
        };

        // --- defaults: everyone starts as an active student
        expect(await repo.get(S1)).toEqual({ role: "student", accessStatus: "active" });
        expect(await repo.get(ADMIN)).toEqual({ role: "student", accessStatus: "active" });

        // --- the bootstrap (what `admin:promote` does): exactly one row becomes admin
        await tx.execute(sql`update public.student_profiles set role = 'admin' where id = ${ADMIN}`);
        expect((await repo.get(ADMIN))?.role).toBe("admin");
        expect((await repo.get(S1))?.role).toBe("student");

        // --- the database refuses nonsense values
        await rejected(sql`update public.student_profiles set role = 'superuser' where id = ${S1}`, /student_profiles_role_valid|check constraint/i);
        await rejected(sql`update public.student_profiles set access_status = 'maybe' where id = ${S1}`, /student_profiles_access_status_valid|check constraint/i);

        // --- a STUDENT cannot change their own role or access, nor anyone else's; they can still edit their name
        await withUser(udb, S1, async (stx) => {
          const attempt = async (query: ReturnType<typeof sql>) => {
            try {
              await stx.transaction(async (sp) => sp.execute(query));
            } catch (err) {
              const e = err as Error & { cause?: Error };
              expect(e.cause?.message ?? e.message).toMatch(/permission denied/i);
              return;
            }
            throw new Error("expected permission denied");
          };
          await attempt(sql`update public.student_profiles set role = 'admin' where id = ${S1}`);
          await attempt(sql`update public.student_profiles set access_status = 'active' where id = ${S1}`);
          await attempt(sql`update public.student_profiles set access_changed_by = ${S1} where id = ${S1}`);
          const own = (await stx.execute(sql`update public.student_profiles set display_name = 'Renamed' where id = ${S1} returning display_name`)) as unknown as Array<{ display_name: string }>;
          expect(own[0]?.display_name).toBe("Renamed");
          const others = (await stx.execute(sql`update public.student_profiles set display_name = 'Hacked' where id = ${S2} returning id`)) as unknown as unknown[];
          expect(others).toHaveLength(0); // RLS: not their row, nothing matched
          const seen = (await stx.execute(sql`select id from public.student_profiles`)) as unknown as Array<{ id: string }>;
          expect(seen.map((r) => r.id)).toEqual([S1]);
        });
        expect((await repo.get(S1))?.role).toBe("student");

        // --- admin listing joins the e-mail from auth, searches, and never returns more than asked
        const found = await repo.listStudents("role-test@invalid", 10);
        expect(found.total).toBe(3);
        expect(found.rows.map((r) => r.email).sort()).toEqual(["admin-role-test@invalid.test", "student1-role-test@invalid.test", "student2-role-test@invalid.test"]);
        expect((await repo.listStudents("role-test@invalid", 2)).rows).toHaveLength(2);
        expect((await repo.listStudents("%", 10)).total).toBe(0); // "%" is plain text, not a wildcard
        expect((await repo.listStudents("student two", 10)).rows.map((r) => r.id)).toEqual([S2]);

        // --- pausing: students only; an admin id is refused by the repository itself
        expect(await repo.setAccess(ADMIN, "revoked", ADMIN)).toBeNull();
        expect((await repo.get(ADMIN))?.accessStatus).toBe("active");
        const paused = await repo.setAccess(S1, "revoked", ADMIN);
        expect(paused).toMatchObject({ id: S1, accessStatus: "revoked" });
        expect(paused?.accessChangedAt).not.toBeNull();
        const audit = (await tx.execute(sql`select access_changed_by from public.student_profiles where id = ${S1}`)) as unknown as Array<{ access_changed_by: string }>;
        expect(audit[0]?.access_changed_by).toBe(ADMIN);

        // --- the audit log recorded the pause (who, what, to whom), and a refused change recorded nothing
        const audit1 = await repo.listAudit({}, 10);
        expect(audit1.entries.map((e) => [e.action, e.actorName, e.targetName])).toEqual([["access_paused", "Role Admin", "Renamed"]]);

        // --- Users & Access columns and the Audit Log numbers come from real data
        const ravi = (await repo.listStudents("student1-role-test@invalid", 5)).rows[0]!;
        expect(ravi).toMatchObject({ accessChangedByName: "Role Admin", lastSignInAt: null });
        const range = await repo.listAudit({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() }, 10);
        expect(range.summary.inRange.paused).toBe(1);
        expect(range.summary.actions24h).toBeGreaterThanOrEqual(1);
        expect(range.summary.accounts.total).toBeGreaterThanOrEqual(3);
        expect(range.summary.accounts.neverSignedIn).toBeGreaterThanOrEqual(3); // the three synthetic accounts never signed in
        expect((await repo.listAudit({ from: new Date(Date.now() + 86_400_000).toISOString() }, 10)).entries).toHaveLength(0);

        // --- bug reports: saved against the verified user, capped per day, resolved with an audit entry
        const bugs = createBugRepository(udb);
        const made = await bugs.create(S2, { title: "Button does nothing", description: "Pressing Save on settings does nothing at all.", page: "/settings?x=1" });
        const inbox = await bugs.list("open", 10);
        expect(inbox.reports[0]).toMatchObject({ id: made.id, reporterName: "Role Student Two", page: "/settings", status: "open" });
        expect(inbox.counts.open).toBeGreaterThanOrEqual(1);
        // the Bug Tracker board: type/severity default, then Open -> In progress is audited too
        expect(inbox.reports[0]).toMatchObject({ type: "bug", severity: "medium" });
        const typed = await bugs.create(S2, { title: "Please add charts", description: "A weekly study chart would help me a lot.", type: "feature", severity: "high" });
        expect((await bugs.list(null, 10)).reports.find((r) => r.id === typed.id)).toMatchObject({ type: "feature", severity: "high" });
        const working = await bugs.setStatus(made.id, "in_progress", ADMIN);
        expect(working).toMatchObject({ status: "in_progress", resolvedAt: null });
        expect((await bugs.list(null, 10)).counts.in_progress).toBe(1);
        expect((await repo.listAudit({}, 20)).entries.some((e) => e.action === "bug_in_progress")).toBe(true);
        const solved = await bugs.setStatus(made.id, "resolved", ADMIN);
        expect(solved).toMatchObject({ status: "resolved" });
        expect(solved?.resolvedAt).not.toBeNull();
        expect((await repo.listAudit({}, 10)).entries.find((e) => e.action === "bug_resolved")).toMatchObject({ actorName: "Role Admin" }); // (one test transaction = one timestamp, so order is not asserted here)
        expect(await bugs.setStatus("00000000-0000-4000-8000-0000000000ff", "resolved", ADMIN)).toBeNull();
        await rejected(sql`insert into public.bug_reports (user_id, title, description) values (${S2}, 'ab', 'long enough description')`, /bug_reports_title_len|check constraint/i);
        await rejected(sql`update public.bug_reports set status = 'maybe'`, /bug_reports_status_valid|check constraint/i);

        // --- the two admin tables are invisible to every client role: students and anon get "permission denied"
        for (const table of ["audit_log", "bug_reports"]) {
          await withUser(udb, S1, async (stx) => {
            try {
              await stx.transaction(async (sp) => sp.execute(sql.raw(`select * from public.${table}`)));
              throw new Error("student could read " + table);
            } catch (err) {
              const e = err as Error & { cause?: Error };
              expect(e.cause?.message ?? e.message).toMatch(/permission denied/i);
            }
          });
        }

        // --- over HTTP, with real token verification
        const app = await buildApp({ env, db: tx as unknown as Database, ai: new MockProvider(), verifyToken, accessRepo: repo });
        let n = 0;
        const call = (token: string, method: "GET" | "POST", url: string, payload?: unknown) =>
          app.inject({ method, url, remoteAddress: `10.6.0.${++n}`, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
        const adminToken = await tokenFor(ADMIN, "admin-role-test@invalid.test");
        const s1Token = await tokenFor(S1, "student1-role-test@invalid.test");
        const s2Token = await tokenFor(S2, "student2-role-test@invalid.test");

        const blocked = await call(s1Token, "GET", "/api/me");
        expect(blocked.statusCode).toBe(403);
        expect(blocked.json().error).toBe("access_revoked");
        expect((await call(s2Token, "GET", "/api/me")).json()).toMatchObject({ profile: { id: S2, role: "student" } });
        expect((await call(s2Token, "GET", "/api/admin/students")).statusCode).toBe(403);
        expect((await call(adminToken, "GET", "/api/me")).json().profile.role).toBe("admin");
        expect((await call(adminToken, "GET", "/api/admin/students?q=role-test@invalid")).json().total).toBe(3);

        const restored = await call(adminToken, "POST", `/api/admin/students/${S1}/access`, { status: "active" });
        expect(restored.statusCode).toBe(200);
        expect((await call(s1Token, "GET", "/api/me")).statusCode).toBe(200);
        expect((await call(adminToken, "POST", `/api/admin/students/${ADMIN}/access`, { status: "revoked" })).statusCode).toBe(400);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }, 120_000);
});
