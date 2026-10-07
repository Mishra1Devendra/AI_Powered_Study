import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { deckDetailResponseSchema, mindmapResponseSchema, studyQueueResponseSchema } from "@copilot/shared";
import { buildApp } from "../app.js";
import { createTokenVerifier } from "../auth/verify-token.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createStudyToolsRepository } from "./repository.js";

/** FLASHCARDS + MIND MAPS against the real database (rolled back): rows stored, spaced repetition persisted, isolation, no client access, cascade. */
const A = "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3";
const B = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

describe.skipIf(!live)("flashcards and mind maps (live DB, rolled back)", () => {
  it("decks, cards, reviews and maps persist correctly, stay private, and cannot be reached by a student's database role", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test" });
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const tokenFor = (sub: string) =>
      new SignJWT({ sub, role: "authenticated", email: `${sub.slice(0, 4)}-study@invalid.test` })
        .setProtectedHeader({ alg: "ES256", kid: "k" })
        .setIssuer(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(pair.privateKey);

    await expect(
      db.transaction(async (tx) => {
        for (const [id, name] of [[A, "Study A"], [B, "Study B"]] as const) {
          await tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`${id.slice(0, 4)}-study@invalid.test`}, ${JSON.stringify({ display_name: name })}::jsonb, now(), now())`);
        }
        const udb = tx as unknown as Database;
        const app = await buildApp({ env, db: udb, ai: new MockProvider(0), verifyToken, studyToolsRepo: createStudyToolsRepository(udb) });
        let n = 0;
        const call = async (who: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
          app.inject({ method, url, remoteAddress: `10.3.0.${++n}`, headers: { authorization: `Bearer ${await tokenFor(who)}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

        // a deck is written and stored
        const started = await call(A, "POST", "/api/flashcards/decks/generate", { source: { type: "topic", subject: "Biology", topic: "Cells" }, count: 6 });
        expect(started.statusCode).toBe(202);
        const deckId = started.json().deck.id as string;
        await app.studyTools!.idle();
        const got = await call(A, "GET", `/api/flashcards/decks/${deckId}`);
        expect(got.statusCode, got.body).toBe(200);
        const detail = deckDetailResponseSchema.parse(got.json());
        expect(detail.deck).toMatchObject({ status: "ready", cardCount: 6, newCount: 6, isMock: true });

        // a review is persisted exactly as scheduled
        const round = studyQueueResponseSchema.parse((await call(A, "GET", `/api/flashcards/decks/${deckId}/study`)).json());
        const first = round.cards[0]!;
        expect((await call(A, "POST", `/api/flashcards/cards/${first.id}/review`, { grade: "good" })).statusCode).toBe(200);
        const row = (await tx.execute(sql`select interval_days, repetitions, ease_x100, due_at > now() as future, last_reviewed_at is not null as seen from public.flashcards where id = ${first.id}`)) as unknown as Array<{ interval_days: number; repetitions: number; ease_x100: number; future: boolean; seen: boolean }>;
        expect(row[0]).toEqual({ interval_days: 1, repetitions: 1, ease_x100: 250, future: true, seen: true });

        // manual deck + card edit
        const manual = (await call(A, "POST", "/api/flashcards/decks", { title: "By hand" })).json().deck;
        const card = (await call(A, "POST", `/api/flashcards/decks/${manual.id}/cards`, { front: "Q?", back: "A", hint: "h" })).json().card;
        expect((await call(A, "PATCH", `/api/flashcards/cards/${card.id}`, { back: "A2" })).json().card).toMatchObject({ back: "A2", hint: "h" });

        // a mind map is written, stored as JSON and read back
        const m = await call(A, "POST", "/api/mindmaps/generate", { source: { type: "topic", subject: "Cells" }, size: "small" });
        expect(m.statusCode).toBe(202);
        await app.studyTools!.idle();
        const map = mindmapResponseSchema.parse((await call(A, "GET", `/api/mindmaps/${m.json().mindmap.id}`)).json()).mindmap;
        expect(map).toMatchObject({ status: "ready", size: "small" });
        expect(map.tree?.children.length).toBeGreaterThanOrEqual(2);

        // another student sees and changes nothing
        expect((await call(B, "GET", `/api/flashcards/decks/${deckId}`)).statusCode).toBe(404);
        expect((await call(B, "POST", `/api/flashcards/cards/${first.id}/review`, { grade: "easy" })).statusCode).toBe(404);
        expect((await call(B, "DELETE", `/api/mindmaps/${map.id}`)).statusCode).toBe(404);
        expect((await call(B, "GET", "/api/flashcards/decks")).json().decks).toEqual([]);

        // the tables are invisible to a student's own database role
        for (const table of ["flashcard_decks", "flashcards", "mindmaps"]) {
          await withUser(udb, A, async (stx) => {
            try {
              await stx.transaction(async (sp) => sp.execute(sql.raw(`select * from public.${table}`)));
              throw new Error(`student could read ${table}`);
            } catch (err) {
              const e = err as Error & { cause?: Error };
              expect(e.cause?.message ?? e.message).toMatch(/permission denied/i);
            }
          });
        }

        // deleting a deck deletes its cards
        expect((await call(A, "DELETE", `/api/flashcards/decks/${deckId}`)).statusCode).toBe(204);
        const left = (await tx.execute(sql`select count(*)::int as n from public.flashcards where deck_id = ${deckId}`)) as unknown as Array<{ n: number }>;
        expect(left[0]!.n).toBe(0);

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }, 180_000);
});
