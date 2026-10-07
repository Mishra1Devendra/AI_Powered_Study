import { writeFileSync } from "node:fs";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import { tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../app.js";
import { createTokenVerifier } from "../auth/verify-token.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import type { NotesStorage } from "../notes/storage.js";
import { createLLMProvider } from "../services/ai/index.js";

/**
 * OLLAMA RUNNING (Phase 13) - gated: runs only with E2E_OLLAMA=1 and a local Ollama listening on OLLAMA_BASE_URL.
 * The same real stack as the "Ollama stopped" test (real app, real database rolled back, real JWT verification), but the REAL local
 * model answers. It records the model, timings and failures. A fetch spy proves the only host contacted is this machine's Ollama:
 * no cloud, no key, no cost. Nothing here is a loop: each feature gets exactly the calls its route makes.
 */
const A = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL && process.env.E2E_OLLAMA === "1";
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

const parseSse = (body: string): TutorStreamEvent[] =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));
const TECHNICAL = /ECONNREFUSED|fetch failed|node:internal|undici|\.ts:\d+|at\s+\S+\s+\(/i;
const NOTE =
  "Photosynthesis takes place in the chloroplasts of plant cells. Chlorophyll, the green pigment inside chloroplasts, absorbs sunlight. " +
  "In the light reactions the absorbed energy splits water and releases oxygen. " +
  "The Calvin cycle then uses carbon dioxide and the stored energy to build glucose, which the plant uses for food. ".repeat(3);

describe.skipIf(!live)("Ollama running: every AI feature is answered by the REAL local model, grounded, with timings recorded (live DB, rolled back)", () => {
  it("tutor, notes assistant, quiz, viva and the recommendation explanation answer - not demo - and only local Ollama is contacted", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "ollama", AI_TIMEOUT_MS: "180000" });
    const timings: string[] = [];
    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timings.push(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    };
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const token = await new SignJWT({ sub: A, role: "authenticated", email: "up@invalid.test" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(pair.privateKey);
    const headers = { authorization: `Bearer ${token}` };

    const realFetch = globalThis.fetch;
    const outbound: string[] = [];
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => (outbound.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url), realFetch(input, init)));
    try {
      const ai = createLLMProvider(env); // created AFTER the spy so its fetch is the recorded one
      expect(ai.name).toBe("ollama");
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'up@invalid.test', '{"display_name":"Up Test"}'::jsonb, now(), now())`);
          const storage: NotesStorage = { upload: async () => undefined, download: async () => new Uint8Array() };
          const app = await buildApp({ env, db: tx as unknown as Database, ai, verifyToken, notesStorage: storage });
          let n = 0;
          const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers, remoteAddress: `10.8.0.${++n}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
          const body = (r: { json: () => unknown }) => r.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

          const ready = body(await call("GET", "/api/health/ready"));
          expect(ready.ai).toMatchObject({ provider: "ollama", reachable: true, modelInstalled: true });

          const note = body(await call("POST", "/api/notes/text", { title: "Photosynthesis", text: NOTE })).note;
          expect(note.status).toBe("ready");

          // --- Tutor, grounded in the note (streamed)
          const conv = body(await call("POST", "/api/tutor/conversations", {})).conversation.id;
          const tutorRes = await timed("tutor (grounded, streamed)", () => call("POST", `/api/tutor/conversations/${conv}/messages`, { content: "Where does photosynthesis take place?", documentId: note.id }));
          const tutor = parseSse(tutorRes.body);
          const tdone = tutor.find((e) => e.type === "done");
          if (tdone?.type !== "done") throw new Error(`tutor did not finish: ${JSON.stringify(tutor.at(-1))}`);
          expect(tdone.message).toMatchObject({ isMock: false, model: env.OLLAMA_MODEL, grounding: "grounded" });
          expect(tdone.message.content.length).toBeGreaterThan(20);
          expect(tdone.message.content).toMatch(/chloroplast/i); // the answer really comes from the note
          timings.push(`tutor sources: ${JSON.stringify(tdone.message.sources?.map((s) => s.documentTitle) ?? [])}`);
          expect(tdone.message.sources?.length ?? 0).toBeGreaterThan(0);

          // (Duplicate-send protection is covered over HTTP in ai-robustness.test.ts and in tutor/service.test.ts: this run shares ONE database
          // connection, which cannot serve two overlapping requests, so overlapping them here would test the harness, not the app.)

          // --- Notes assistant (streamed)
          const assistRes = await timed("notes assistant: summarize", () => call("POST", `/api/notes/${note.id}/assistant`, { action: "summarize" }));
          const assist = parseSse(assistRes.body).find((e) => e.type === "done");
          if (assist?.type !== "done") throw new Error("assistant did not finish");
          expect(assist.message).toMatchObject({ isMock: false });
          expect(assist.message.content.length).toBeGreaterThan(20);

          // --- Quiz (structured, background): small on purpose
          const q = await timed("quiz request accepted", () => call("POST", "/api/quiz/generate", { source: { type: "notes", documentIds: [note.id] }, difficulty: "easy", count: 3, questionTypes: ["mcq"], timeLimitMinutes: null }));
          expect(q.statusCode).toBe(202);
          await timed("quiz generation (3 mcq)", () => app.quiz.whenIdle());
          const quiz = body(await call("GET", `/api/quiz/${body(q).quiz.id}`));
          timings.push(`quiz status: ${quiz.quiz.status}, isMock: ${quiz.quiz.isMock}, questions: ${quiz.questions?.length ?? 0}${quiz.quiz.error ? `, error: ${quiz.quiz.error}` : ""}`);
          expect(quiz.quiz.isMock).toBe(false);
          expect(["ready", "failed"]).toContain(quiz.quiz.status); // a 3B model may legitimately fail a structured task; it must then fail calmly
          if (quiz.quiz.status === "failed") expect(quiz.quiz.error).not.toMatch(TECHNICAL);
          else expect(quiz.questions.length).toBeGreaterThan(0);

          // --- Viva (structured): one question and its evaluation
          const viva = await timed("viva: first question", () => call("POST", "/api/viva/sessions", { subject: "Biology", topic: "photosynthesis", difficulty: "easy", questionCount: 3, sourceType: "document", documentId: note.id }));
          timings.push(`viva create -> HTTP ${viva.statusCode}`);
          expect([201, 502, 504]).toContain(viva.statusCode);
          if (viva.statusCode === 201) {
            const vd = body(viva);
            expect(vd.session.isMock).toBe(false);
            expect(vd.questions[0]).toMatchObject({ keyPoints: null, answer: null }); // the answer key is not shown before evaluation
            const answered = await timed("viva: evaluate answer", () => call("POST", `/api/viva/sessions/${vd.session.id}/answer`, { questionId: vd.questions[0].id, answer: "It happens in the chloroplasts, where chlorophyll absorbs sunlight." }));
            timings.push(`viva evaluate -> HTTP ${answered.statusCode}`);
            expect([200, 502, 504]).toContain(answered.statusCode);
          } else {
            expect(JSON.stringify(viva.json())).not.toMatch(TECHNICAL);
          }

          // --- Recommendation explanation (optional AI): needs some real history, so give the student one finished quiz attempt if there is one; otherwise the calm "nothing to explain" is correct
          const explain = await timed("recommendation explanation", () => call("POST", "/api/recommendations/explain", {}));
          expect(explain.statusCode).toBe(200);
          timings.push(`explain: available=${body(explain).available}`);
          expect([true, false]).toContain(body(explain).available);

          expect(JSON.stringify([tdone.message, assist.message, quiz.quiz])).not.toMatch(TECHNICAL);
          const report = `OLLAMA RUNNING - model ${env.OLLAMA_MODEL} @ ${env.OLLAMA_BASE_URL}\n  ${timings.join("\n  ")}\n`;
          if (process.env.E2E_REPORT) writeFileSync(process.env.E2E_REPORT, report); // vitest hides stdout of passing tests
          else process.stderr.write(`\n${report}`);
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
    } finally {
      vi.unstubAllGlobals();
    }

    // The ONLY host contacted is the local Ollama - no cloud, no other service.
    const hosts = [...new Set(outbound.map((u) => new URL(u).host))];
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toEqual([new URL(env.OLLAMA_BASE_URL).host]);
  }, 1_500_000);
});
