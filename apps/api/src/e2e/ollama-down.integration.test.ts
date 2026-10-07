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
 * OLLAMA STOPPED (Phase 13). The real app, real database (rolled back), real JWT verification - and an Ollama address nothing is
 * listening on (port 11999 on this machine), which is exactly what a stopped Ollama looks like to the app: the connection is
 * refused. Pointing at a dead port instead of killing the developer's real Ollama exercises the identical code path.
 * Every outbound request the process makes is recorded: the only host ever contacted must be this machine.
 */
const A = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

const parseSse = (body: string): TutorStreamEvent[] =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));
const TECHNICAL = /ECONNREFUSED|11999|127\.0\.0\.1|localhost|fetch failed|stack|at\s+\S+\s+\(|node:internal|TypeError|undici|\.ts:\d+/i;

describe.skipIf(!live)("Ollama stopped: every AI feature falls back to the LABELLED demo AI, calmly, with no cloud call (live DB, rolled back)", () => {
  it("tutor, notes assistant, quiz, study plan, viva and the recommendation explanation all answer - marked as demo - and nothing but this machine is contacted", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11999", AI_TIMEOUT_MS: "5000" });
    const pair = await generateKeyPair("ES256");
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256", use: "sig" };
    const verifyToken = createTokenVerifier(env.SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
    const token = await new SignJWT({ sub: A, role: "authenticated", email: "down@invalid.test" })
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
      // created AFTER the spy so the provider's fetch is the recorded one
      const ai = createLLMProvider(env);
      expect(ai.name).toBe("ollama"); // configured as the local provider, which is down
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'down@invalid.test', '{"display_name":"Down Test"}'::jsonb, now(), now())`);
          const storage: NotesStorage = { upload: async () => undefined, download: async () => new Uint8Array() };
          const app = await buildApp({ env, db: tx as unknown as Database, ai, verifyToken, notesStorage: storage });
          let n = 0;
          const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers, remoteAddress: `10.9.0.${++n}`, ...(payload !== undefined ? { payload: payload as object } : {}) });
          const body = (r: { json: () => unknown }) => r.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

          // health tells the truth without generating anything
          const ready = body(await call("GET", "/api/health/ready"));
          expect(ready.ai).toMatchObject({ provider: "ollama", reachable: false });

          // a note to ask about
          const text = "Photosynthesis takes place in the chloroplasts of plant cells. ".repeat(30) + "The Calvin cycle builds glucose from carbon dioxide. ".repeat(30);
          const note = body(await call("POST", "/api/notes/text", { title: "Bio", text })).note;
          expect(note.status).toBe("ready");

          // --- Tutor (streamed)
          const conv = body(await call("POST", "/api/tutor/conversations", {})).conversation.id;
          const tutor = parseSse((await call("POST", `/api/tutor/conversations/${conv}/messages`, { content: "Explain photosynthesis simply.", documentId: note.id })).body);
          const tdone = tutor.find((e) => e.type === "done");
          if (tdone?.type !== "done") throw new Error(`tutor did not finish: ${JSON.stringify(tutor.at(-1))}`);
          expect(tdone.message).toMatchObject({ isMock: true, model: "mock-demo", grounding: "grounded" }); // demo AI, but still grounded in the note
          expect(tdone.message.content).toMatch(/Ollama\) is not running/i); // the reply says so, in words
          expect(tdone.message.content).not.toMatch(TECHNICAL.source.replace("Ollama", "XX"));

          // --- Notes assistant (streamed)
          const assist = parseSse((await call("POST", `/api/notes/${note.id}/assistant`, { action: "summarize" })).body).find((e) => e.type === "done");
          if (assist?.type !== "done") throw new Error("assistant did not finish");
          expect(assist.message).toMatchObject({ isMock: true });

          // --- Quiz (structured, background)
          const q = await call("POST", "/api/quiz/generate", { source: { type: "topic", subject: "Biology", topic: "Photosynthesis" }, difficulty: "easy", count: 3, questionTypes: ["mcq"], timeLimitMinutes: null });
          expect(q.statusCode).toBe(202);
          await app.quiz.whenIdle();
          const quiz = body(await call("GET", `/api/quiz/${body(q).quiz.id}`)).quiz;
          expect(quiz).toMatchObject({ status: "ready", isMock: true });

          // --- Study plan (structured, background)
          const exam = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
          const plan = await call("POST", "/api/study-plans/generate", { title: "Boards", examDate: exam, targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", subjects: [{ name: "Biology", priority: "high", topics: ["Photosynthesis"] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" });
          expect(plan.statusCode).toBe(202);
          await app.planner.whenIdle();
          const planDetail = body(await call("GET", `/api/study-plans/${body(plan).plan.id}`));
          expect(planDetail.plan.status).toBe("active");
          expect(planDetail.plan.isMock).toBe(true);

          // --- Viva (structured)
          const viva = await call("POST", "/api/viva/sessions", { subject: "Biology", topic: "photosynthesis", difficulty: "easy", questionCount: 3, sourceType: "document", documentId: note.id });
          expect(viva.statusCode).toBe(201);
          const vd = body(viva);
          expect(vd.session.isMock).toBe(true);
          const answered = await call("POST", `/api/viva/sessions/${vd.session.id}/answer`, { questionId: vd.questions[0].id, answer: "It happens in the chloroplasts using sunlight." });
          expect(answered.statusCode).toBe(200);

          // --- Recommendation explanation (optional AI)
          await call("POST", "/api/recommendations/explain", {}); // 200 with available true/false; never an error page
          const explain = await call("POST", "/api/recommendations/explain", {});
          expect(explain.statusCode).toBe(200);
          expect([true, false]).toContain(body(explain).available);

          // --- nothing technical anywhere in what students saw
          for (const r of [ready, tdone.message, assist.message, quiz, planDetail.plan, vd.session]) expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|fetch failed|node:internal|\.ts:\d+/);

          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
    } finally {
      vi.unstubAllGlobals();
    }

    // The ONLY network destination the whole run tried to reach is this machine's (dead) Ollama port - no cloud, no other host.
    const hosts = [...new Set(outbound.map((u) => new URL(u).host))];
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).toEqual(["127.0.0.1:11999"]);
  }, 600_000);
});
