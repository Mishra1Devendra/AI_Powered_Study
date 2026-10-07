import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { dashboardSchema, tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../app.js";
import { createTokenVerifier } from "../auth/verify-token.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";

/**
 * End-to-end through the real stack, except for the Supabase token SIGNER and the LLM:
 *   real Fastify app -> real JWT verification (locally generated keys) -> real service ->
 *   real repository -> real Supabase Postgres with real RLS -> mock AI provider.
 * Two synthetic users live inside one transaction that is ALWAYS rolled back, so nothing is
 * persisted and no real account is touched.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLLBACK = new Error("rollback");

const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

const parseSse = (body: string): TutorStreamEvent[] =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));

describe.skipIf(!process.env.DATABASE_URL || !process.env.SUPABASE_URL)("AI Tutor end to end (live DB, rolled back)", () => {
  it("create, send, stream, reload, regenerate, isolate and soft-delete through the real API", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test" });
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const token = (sub: string, email: string) =>
      new SignJWT({ sub, role: "authenticated", email })
        .setProtectedHeader({ alg: "ES256", kid: "k" })
        .setIssuer(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(pair.privateKey);
    const ta = { authorization: `Bearer ${await token(A, "a@invalid.test")}` };
    const tb = { authorization: `Bearer ${await token(B, "b@invalid.test")}` };

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
          values
            (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
            (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);

        const app = await buildApp({ env, db: tx as unknown as Database, ai: new MockProvider(0), verifyToken });
        const url = "/api/tutor/conversations";

        // --- Student A creates a conversation with optional context
        const created = await app.inject({ method: "POST", url, headers: ta, payload: { subject: "Physics", topic: "Thermodynamics", level: "intermediate" } });
        expect(created.statusCode).toBe(201);
        const conv = created.json().conversation;
        expect(conv).toMatchObject({ title: "New conversation", subject: "Physics", level: "intermediate" });

        // --- Sends a message in a tutoring mode; the reply streams back and is stored
        const sent = await app.inject({ method: "POST", url: `${url}/${conv.id}/messages`, headers: ta, payload: { content: "What is entropy?", mode: "test_me" } });
        expect(sent.statusCode).toBe(200);
        const events = parseSse(sent.body);
        expect(events.map((e) => e.type)[0]).toBe("user_message");
        expect(events.at(-1)?.type).toBe("done");
        expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(2);

        // --- "Reload": history comes back from the database, in order, with provenance
        const detail = (await app.inject({ url: `${url}/${conv.id}`, headers: ta })).json();
        expect(detail.conversation.title).toBe("What is entropy?");
        expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
        expect(detail.messages[0]).toMatchObject({ mode: "test_me", isMock: false });
        expect(detail.messages[1]).toMatchObject({ isMock: true, model: "mock-demo" });
        expect(detail.messages[1].content).toContain("Tutor mode seen by the provider: test_me");

        // --- Dashboard shows the real conversation as recent activity; profile came from the signup trigger
        const dash = dashboardSchema.parse((await app.inject({ url: "/api/dashboard", headers: ta })).json());
        expect(dash.profile.displayName).toBe("Alice");
        expect(dash.activity).toHaveLength(1);
        expect(dash.activity[0]).toMatchObject({ type: "tutor", title: "What is entropy?", detail: "Physics · Thermodynamics", href: `/tutor/${conv.id}` });

        // --- Student B cannot touch A's conversation by guessing/altering the id (real RLS + ownership checks)
        const forbidden = await Promise.all([
          app.inject({ url: `${url}/${conv.id}`, headers: tb }),
          app.inject({ method: "PATCH", url: `${url}/${conv.id}`, headers: tb, payload: { title: "pwned" } }),
          app.inject({ method: "DELETE", url: `${url}/${conv.id}`, headers: tb }),
        ]);
        for (const r of forbidden) {
          expect(r.statusCode).toBe(404);
          expect(r.body).not.toContain("entropy");
        }
        for (const path of ["messages", "regenerate"]) {
          const r = await app.inject({ method: "POST", url: `${url}/${conv.id}/${path}`, headers: tb, payload: { content: "injected" } });
          expect(r.statusCode).toBe(404);
        }
        expect((await app.inject({ url, headers: tb })).json().conversations).toEqual([]);
        expect(dashboardSchema.parse((await app.inject({ url: "/api/dashboard", headers: tb })).json()).activity).toEqual([]);
        // ...and nothing of A's changed
        const still = (await app.inject({ url: `${url}/${conv.id}`, headers: ta })).json();
        expect(still.conversation.title).toBe("What is entropy?");
        expect(still.messages).toHaveLength(2);

        // --- Unauthenticated callers get nothing
        expect((await app.inject({ url })).statusCode).toBe(401);
        expect((await app.inject({ url: `${url}/${conv.id}`, headers: { authorization: "Bearer forged.token.value" } })).statusCode).toBe(401);

        // --- Regenerate appends a new reply that supersedes the old one (append-only storage)
        const regen = await app.inject({ method: "POST", url: `${url}/${conv.id}/regenerate`, headers: ta });
        expect(parseSse(regen.body).at(-1)?.type).toBe("done");
        const afterRegen = (await app.inject({ url: `${url}/${conv.id}`, headers: ta })).json();
        expect(afterRegen.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]); // collapsed view
        const stored = await tx.execute(sql`select count(*)::int as n from public.messages where conversation_id = ${conv.id}`);
        expect((stored as unknown as Array<{ n: number }>)[0]?.n).toBe(3); // user + original reply + regenerated reply

        // --- A second conversation is independent
        const second = (await app.inject({ method: "POST", url, headers: ta, payload: {} })).json().conversation;
        await app.inject({ method: "POST", url: `${url}/${second.id}/messages`, headers: ta, payload: { content: "Different topic" } });
        const d2 = (await app.inject({ url: `${url}/${second.id}`, headers: ta })).json();
        expect(d2.messages).toHaveLength(2);
        expect(JSON.stringify(d2)).not.toContain("entropy");
        expect((await app.inject({ url, headers: ta })).json().conversations).toHaveLength(2);

        // --- Soft delete hides it but keeps the rows
        expect((await app.inject({ method: "DELETE", url: `${url}/${conv.id}`, headers: ta })).statusCode).toBe(204);
        expect((await app.inject({ url, headers: ta })).json().conversations.map((c: { id: string }) => c.id)).toEqual([second.id]);
        expect((await app.inject({ url: `${url}/${conv.id}`, headers: ta })).statusCode).toBe(404);
        const kept = await tx.execute(sql`select count(*)::int as n from public.messages where conversation_id = ${conv.id}`);
        expect((kept as unknown as Array<{ n: number }>)[0]?.n).toBe(3);

        await app.close();
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    const left = await db.execute(sql`select (select count(*) from auth.users where id in (${A}, ${B})) + (select count(*) from public.conversations where user_id in (${A}, ${B})) as n`);
    expect(Number((left as unknown as Array<{ n: string }>)[0]?.n)).toBe(0);
  });
});
