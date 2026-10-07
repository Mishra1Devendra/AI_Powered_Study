import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { planDetailResponseSchema, submitCheckResponseSchema } from "@copilot/shared";
import { buildApp } from "../../app.js";
import { createTokenVerifier } from "../../auth/verify-token.js";
import { loadEnv } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { withUser } from "../../db/with-user.js";
import { MockProvider } from "../../services/ai/mock-provider.js";
import { createCheckRepository } from "./repository.js";

/** STUDY CHECK against the real database (rolled back): real plan + session, questions stored with their key, gate on "complete", RLS. */
const A = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const B = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

describe.skipIf(!live)("study check (live DB, rolled back)", () => {
  it("5 questions with a stored key; passing completes the session; complete is refused without it; the table is invisible to students", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test" });
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const tokenFor = (sub: string) =>
      new SignJWT({ sub, role: "authenticated", email: `${sub.slice(0, 4)}-check@invalid.test` })
        .setProtectedHeader({ alg: "ES256", kid: "k" })
        .setIssuer(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(pair.privateKey);

    await expect(
      db.transaction(async (tx) => {
        for (const [id, name] of [[A, "Check A"], [B, "Check B"]] as const) {
          await tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`${id.slice(0, 4)}-check@invalid.test`}, ${JSON.stringify({ display_name: name })}::jsonb, now(), now())`);
        }
        const udb = tx as unknown as Database;
        const app = await buildApp({ env, db: udb, ai: new MockProvider(0), verifyToken, checkRepo: createCheckRepository(udb) });
        let n = 0;
        const call = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) =>
          app.inject({ method, url, remoteAddress: `10.2.0.${++n}`, headers: { authorization: `Bearer ${await tokenFor(who)}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

        const exam = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
        const gen = await call(A, "POST", "/api/study-plans/generate", { title: "Check plan", examDate: exam, targetScore: null, minutesPerDay: 90, knowledgeLevel: "beginner", subjects: [{ name: "Biology", priority: "high", topics: ["Cells"] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" });
        expect(gen.statusCode).toBe(202);
        await app.planner.whenIdle();
        const detail = planDetailResponseSchema.parse((await call(A, "GET", `/api/study-plans/${gen.json().plan.id}`)).json());
        const sid = detail.sessions[0]!.id;

        // the gate: a never-checked session cannot be completed directly
        const direct = await call(A, "POST", `/api/study-sessions/${sid}/complete`, {});
        expect(direct.statusCode).toBe(409);
        expect(direct.json().error).toBe("check_required");

        // start -> 5 questions, no key in the response
        const started = await call(A, "POST", `/api/study-sessions/${sid}/check`);
        expect(started.statusCode).toBe(202);
        await app.checks!.whenIdle();
        const ready = (await call(A, "GET", `/api/study-sessions/${sid}/check`)).json().check;
        expect(ready.status).toBe("ready");
        expect(ready.questions).toHaveLength(5);
        expect(JSON.stringify(ready)).not.toMatch(/correctIndex|explanation/);

        // another student cannot reach it
        expect((await call(B, "GET", `/api/study-sessions/${sid}/check`)).json().check).toBeNull();
        expect((await call(B, "POST", `/api/study-sessions/${sid}/check`)).statusCode).toBe(404);

        // the key is stored on the server (read with the privileged connection), and students cannot read the table at all
        const stored = (await tx.execute(sql`select questions from public.session_checks where id = ${ready.id}`)) as unknown as Array<{ questions: Array<{ id: string; correctIndex: number; options: string[] }> }>;
        const key = stored[0]!.questions;
        expect(key).toHaveLength(5);
        await withUser(udb, A, async (stx) => {
          try {
            await stx.transaction(async (sp) => sp.execute(sql`select * from public.session_checks`));
            throw new Error("student could read session_checks");
          } catch (err) {
            const e = err as Error & { cause?: Error };
            expect(e.cause?.message ?? e.message).toMatch(/permission denied/i);
          }
        });

        // fail first (2 of 5): still open
        const wrong = key.map((q, i) => ({ questionId: q.id, choice: i < 2 ? q.correctIndex : (q.correctIndex + 1) % q.options.length }));
        const failed = submitCheckResponseSchema.parse((await call(A, "POST", `/api/study-sessions/${sid}/check/${ready.id}/answers`, { answers: wrong })).json());
        expect(failed.check).toMatchObject({ status: "failed", score: 2 });
        expect(failed.session).toBeNull();
        expect((await call(A, "POST", `/api/study-sessions/${sid}/complete`, {})).statusCode).toBe(409);

        // a new set, then pass (4 of 5): the session is completed in the database
        const second = (await call(A, "POST", `/api/study-sessions/${sid}/check`)).json().check;
        expect(second.id).not.toBe(ready.id);
        await app.checks!.whenIdle();
        const key2 = ((await tx.execute(sql`select questions from public.session_checks where id = ${second.id}`)) as unknown as Array<{ questions: Array<{ id: string; correctIndex: number; options: string[] }> }>)[0]!.questions;
        const mostly = key2.map((q, i) => ({ questionId: q.id, choice: i < 4 ? q.correctIndex : (q.correctIndex + 1) % q.options.length }));
        const passed = submitCheckResponseSchema.parse((await call(A, "POST", `/api/study-sessions/${sid}/check/${second.id}/answers`, { answers: mostly })).json());
        expect(passed.check).toMatchObject({ status: "passed", score: 4 });
        expect(passed.session).toMatchObject({ id: sid, status: "completed" });
        const row = (await tx.execute(sql`select status, completed_at from public.study_sessions where id = ${sid}`)) as unknown as Array<{ status: string; completed_at: Date | null }>;
        expect(row[0]).toMatchObject({ status: "completed" });
        expect(row[0]!.completed_at).not.toBeNull();

        // replaying the passed submission changes nothing
        expect((await call(A, "POST", `/api/study-sessions/${sid}/check/${second.id}/answers`, { answers: mostly })).statusCode).toBe(409);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }, 180_000);
});
