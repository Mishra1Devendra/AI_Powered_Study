import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  NOT_IN_NOTES_MESSAGE,
  dashboardSchema,
  notificationsResponseSchema,
  progressResponseSchema,
  recommendationsResponseSchema,
  searchResponseSchema,
  tutorStreamEventSchema,
  type TutorStreamEvent,
} from "@copilot/shared";
import { buildApp, type BuiltApp } from "../app.js";
import { createTokenVerifier } from "../auth/verify-token.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { makePdf } from "../notes/testing/pdf.js";
import type { NotesStorage } from "../notes/storage.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { GenerateTextRequest, LLMProvider } from "../services/ai/types.js";

/**
 * REAL-STACK END-TO-END (Phase 13). What is real: the Fastify app and every route, JWT verification (against locally generated
 * keys), the services and repositories, Supabase PostgreSQL with its real Row Level Security and grants, the PDF text extraction
 * and chunking, full-text retrieval. What is substituted: the Supabase token SIGNER (tokens are signed locally for two SYNTHETIC
 * users - no account is created at Supabase Auth), the Storage HTTP API (a Map; storage policies are tested in SQL below) and
 * the model (the labelled mock; the real-Ollama run is e2e/ollama.integration.test.ts).
 * Every row lives in ONE transaction that is ALWAYS rolled back: nothing is persisted and no real student is touched.
 */
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;

const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ------------------------------------------------------------------ a small, real PDF about photosynthesis */

const PAGE_1 = [
  "Photosynthesis takes place in the chloroplasts of plant cells.",
  "Chlorophyll is the green pigment that absorbs sunlight for photosynthesis.",
  "The light reactions capture solar energy and produce ATP and NADPH.",
  "Water molecules are split during the light reactions and oxygen is released.",
  "The thylakoid membranes inside each chloroplast hold the chlorophyll molecules.",
  "Photosynthesis converts carbon dioxide and water into glucose and oxygen.",
];
const PAGE_2 = [
  "The Calvin cycle uses ATP and NADPH to build glucose from carbon dioxide.",
  "The Calvin cycle takes place in the stroma, the fluid around the thylakoids.",
  "Rubisco is the enzyme that fixes carbon dioxide during the Calvin cycle.",
  "Stomata are tiny pores that let carbon dioxide enter the leaf and oxygen leave it.",
  "Light intensity, temperature and carbon dioxide level limit the rate of photosynthesis.",
  "Plants store the glucose they make as starch for later use as energy.",
];
const SENTENCE_P1 = "Photosynthesis takes place in the chloroplasts of plant cells";
const SENTENCE_P2 = "Rubisco is the enzyme that fixes carbon dioxide during the Calvin cycle";

function multipart(filename: string, bytes: Uint8Array, contentType = "application/pdf") {
  const boundary = "----e2eBoundary7MA4YWxkTrZu0gW";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, Buffer.from(bytes), tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Records every AI request (kind + prompt) so the test can prove WHAT the model was given. */
function recording(inner: LLMProvider) {
  const requests: Array<{ kind: "stream" | "generate"; system: string; user: string }> = [];
  const ai: LLMProvider = {
    name: inner.name,
    model: inner.model,
    isMock: inner.isMock,
    generateText: (r: GenerateTextRequest) => (requests.push({ kind: "generate", system: r.system ?? "", user: r.messages.at(-1)?.content ?? "" }), inner.generateText(r)),
    streamText: (r: GenerateTextRequest) => (requests.push({ kind: "stream", system: r.system ?? "", user: r.messages.at(-1)?.content ?? "" }), inner.streamText(r)),
  };
  return { ai, requests };
}

const parseSse = (body: string): TutorStreamEvent[] =>
  body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function makeAuth(supabaseUrl: string) {
  const pair = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "e2e", alg: "ES256", use: "sig" };
  const verifyToken = createTokenVerifier(supabaseUrl, createLocalJWKSet({ keys: [jwk] }));
  const issuer = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const sign = (claims: Record<string, unknown>, key: CryptoKey = pair.privateKey, exp: string | number = "2h", kid = "e2e") =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid }).setIssuer(issuer).setAudience("authenticated").setIssuedAt().setExpirationTime(exp).sign(key);
  return { verifyToken, sign, pair };
}

describe.skipIf(!live)("real-stack end to end: one student's whole journey, then a second student tries to get in (live DB, rolled back)", () => {
  it("signup profile -> note (real PDF) -> grounded tutor -> quiz -> study plan -> viva -> progress -> recommendations -> search/notifications; B is locked out of every one of A's records", async () => {
    const env = loadEnv({ ...process.env, NODE_ENV: "test" });
    const { verifyToken, sign } = await makeAuth(env.SUPABASE_URL);
    const tokenA = await sign({ sub: A, role: "authenticated", email: "e2e-a@invalid.test" });
    const tokenB = await sign({ sub: B, role: "authenticated", email: "e2e-b@invalid.test" });
    const hdr = (t: string) => ({ authorization: `Bearer ${t}` });
    const log: string[] = [];

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
            (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-a@invalid.test', '{"display_name":"E2E Alice"}'::jsonb, now(), now()),
            (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2e-b@invalid.test', '{"display_name":"E2E Bob"}'::jsonb, now(), now())`);

        const stored = new Map<string, { bytes: Uint8Array; mime: string }>();
        const storage: NotesStorage = {
          async upload(_token, path, bytes, mime) {
            stored.set(path, { bytes: new Uint8Array(bytes), mime });
          },
          async download(_token, path) {
            const o = stored.get(path);
            if (!o) throw new Error("missing object");
            return o.bytes;
          },
        };
        const rec = recording(new MockProvider(0));
        const app: BuiltApp = await buildApp({ env, db: tx as unknown as Database, ai: rec.ai, verifyToken, notesStorage: storage });

        // Each request comes from its own client address, so the per-client rate limits (tested separately below) do not interfere.
        let client = 0;
        const from = () => { client++; return `10.${(client >> 16) & 255}.${(client >> 8) & 255}.${client & 255}`; };
        const api = async (who: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
          app.inject({ method, url, headers: hdr(who), remoteAddress: from(), ...(payload !== undefined ? { payload: payload as object } : {}) });
        const json = (res: { json: () => unknown }) => res.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const priv = async () => tx.execute(sql`reset role`);
        const step = async (name: string, fn: () => Promise<void>) => {
          try {
            await fn();
            log.push(`ok   ${name}`);
          } catch (err) {
            log.push(`FAIL ${name}`);
            (err as Error).message = `[${name}] ${(err as Error).message}`;
            throw err;
          }
        };

        let noteId = "";
        let convId = "";
        let quizId = "";
        let attemptId = "";
        let planId = "";
        let sessionId = "";
        let vivaId = "";
        let vivaQuestionId = "";
        let wrongQuestion = "";

        /* ------------------------------------------------------------ account */
        await step("signup created the profile row (trigger) and /api/me returns it", async () => {
          const me = json(await api(tokenA, "GET", "/api/me"));
          expect(me.profile).toMatchObject({ id: A, displayName: "E2E Alice" });
          expect(me.user.email).toBe("e2e-a@invalid.test");
        });

        await step("a brand-new student's dashboard is honestly empty", async () => {
          const d = dashboardSchema.parse(json(await api(tokenA, "GET", "/api/dashboard")));
          expect(d.profile.displayName).toBe("E2E Alice");
          expect(d.resume ?? null).toBeNull();
          expect([d.plan, d.activity, d.weakTopics].every((x) => x.length === 0)).toBe(true);
          expect(d.today.streakDays).toBeNull();
        });

        /* ------------------------------------------------------------ notes: a real PDF */
        await step("upload a real PDF: stored, extracted, chunked, indexed, READY", async () => {
          const pdf = makePdf([PAGE_1, PAGE_2]);
          const body = multipart("photosynthesis.pdf", pdf);
          const res = await app.inject({ method: "POST", url: "/api/notes", headers: { ...hdr(tokenA), "content-type": body.contentType }, payload: body.payload, remoteAddress: from() });
          expect(res.statusCode).toBe(201);
          const note = json(res).note;
          noteId = note.id;
          expect(note).toMatchObject({ status: "ready", fileType: "pdf", pageCount: 2, indexed: true, title: "photosynthesis" });
          expect(note.chunkCount).toBeGreaterThanOrEqual(1);
          // the original went to storage under the student's own folder, server-chosen path
          expect([...stored.keys()]).toEqual([`${A}/${noteId}/original.pdf`]);
          expect(stored.get(`${A}/${noteId}/original.pdf`)!.mime).toBe("application/pdf");
          // database row agrees (privileged read)
          await priv();
          const [row] = (await tx.execute(sql`select processing_status, page_count, chunk_count, file_type from public.documents where id = ${noteId}`)) as unknown as Array<{ processing_status: string; page_count: number; chunk_count: number }>;
          expect(row).toMatchObject({ processing_status: "ready", page_count: 2, chunk_count: note.chunkCount });
        });

        await step("the stored text IS the PDF's text, with the right page numbers", async () => {
          const content = json(await api(tokenA, "GET", `/api/notes/${noteId}/content?limit=50`));
          const chunks: Array<{ index: number; page: number | null; content: string }> = content.chunks;
          const p1 = chunks.find((c) => c.content.includes(SENTENCE_P1));
          const p2 = chunks.find((c) => c.content.includes(SENTENCE_P2));
          expect(p1?.page).toBe(1);
          expect(p2?.page).toBe(2);
          expect(chunks.map((c) => c.content).join(" ")).not.toMatch(/%PDF|endobj|stream/); // no raw PDF syntax leaked into the text
          const status = json(await api(tokenA, "GET", `/api/notes/${noteId}/index-status`)).index;
          expect(status).toMatchObject({ state: "indexed", method: "keyword", embeddings: false });
        });

        await step("a duplicate upload of the same file is refused clearly (no second document)", async () => {
          const body = multipart("again.pdf", makePdf([PAGE_1, PAGE_2]));
          const res = await app.inject({ method: "POST", url: "/api/notes", headers: { ...hdr(tokenA), "content-type": body.contentType }, payload: body.payload });
          expect(res.statusCode).toBe(409);
          expect(json(res).error).toBe("duplicate_note");
        });

        /* ------------------------------------------------------------ tutor grounded in the note */
        await step("ask the tutor about the note: the ANSWER'S SOURCE is the PDF page that really says it", async () => {
          convId = json(await api(tokenA, "POST", "/api/tutor/conversations", {})).conversation.id;
          const before = rec.requests.length;
          const res = await api(tokenA, "POST", `/api/tutor/conversations/${convId}/messages`, { content: "Where does photosynthesis take place in a plant cell?", documentId: noteId });
          expect(res.statusCode).toBe(200);
          const events = parseSse(res.body);
          const done = events.find((e) => e.type === "done");
          expect(done?.type).toBe("done");
          if (done?.type !== "done") throw new Error("no done");
          expect(done.message.grounding).toBe("grounded");
          const src = done.message.sources![0]!;
          expect(src).toMatchObject({ documentId: noteId, documentTitle: "photosynthesis" });
          // What the model was given contains the PDF's own sentence ...
          const asked = rec.requests.slice(before);
          expect(asked).toHaveLength(1); // exactly one generation
          expect(asked[0]!.system).toContain(SENTENCE_P1);
          // ... and the cited chunk really is the one containing it, on the page the source reports.
          const content = json(await api(tokenA, "GET", `/api/notes/${noteId}/content?limit=50`));
          const cited = content.chunks.find((c: { index: number }) => c.index === src.chunkIndex);
          expect(cited.content).toContain("chloroplasts");
          expect(cited.page).toBe(src.page);
        });

        await step("a question the PDF does not answer: honest 'not in your notes', no AI call, no invented source", async () => {
          const before = rec.requests.length;
          const events = parseSse((await api(tokenA, "POST", `/api/tutor/conversations/${convId}/messages`, { content: "Who won the 1998 football world cup final?", documentId: noteId })).body);
          const done = events.find((e) => e.type === "done");
          if (done?.type !== "done") throw new Error("no done");
          expect(done.message).toMatchObject({ grounding: "not_found", content: NOT_IN_NOTES_MESSAGE });
          expect(done.message.sources).toBeUndefined();
          expect(rec.requests.length).toBe(before);
        });

        /* ------------------------------------------------------------ quiz from the note */
        await step("create a quiz from the note; it becomes ready with exactly the requested questions", async () => {
          const res = await api(tokenA, "POST", "/api/quiz/generate", { source: { type: "notes", documentIds: [noteId] }, difficulty: "easy", count: 3, questionTypes: ["mcq"], timeLimitMinutes: null });
          expect(res.statusCode).toBe(202);
          quizId = json(res).quiz.id;
          await app.quiz.whenIdle();
          const q = json(await api(tokenA, "GET", `/api/quiz/${quizId}`)).quiz;
          expect(q).toMatchObject({ status: "ready", questionCount: 3, sourceType: "notes" });
          expect(q.sources.map((s: { id: string }) => s.id)).toEqual([noteId]);
        });

        let view: { attempt: { id: string }; questions: Array<{ id: string }> };
        await step("start the quiz: NOTHING that reveals an answer is sent while it is active", async () => {
          const res = await api(tokenA, "POST", `/api/quiz/${quizId}/start`);
          expect(res.statusCode).toBe(200);
          view = json(res) as typeof view;
          attemptId = view.attempt.id;
          expect(view.questions).toHaveLength(3);
          await priv();
          const key = (await tx.execute(sql`select id, correct_answer, explanation, options from public.quiz_questions where quiz_id = ${quizId}`)) as unknown as Array<{ id: string; correct_answer: number; explanation: string; options: string[] }>;
          const wire = res.body;
          for (const k of key) {
            expect(wire).not.toContain(k.explanation); // stored explanation text must not be on the wire
            expect(wire).not.toContain(k.id + '","correct');
          }
          expect(wire).not.toMatch(/correctIndex|correct_answer|"correct"|explanation/i);
        });

        await step("answers autosave (and survive a 'refresh'), a wrong id is rejected, and a save does not say right/wrong", async () => {
          await priv();
          const key = new Map(((await tx.execute(sql`select id, correct_answer, options from public.quiz_questions where quiz_id = ${quizId}`)) as unknown as Array<{ id: string; correct_answer: number; options: string[] }>).map((k) => [k.id, k]));
          const [q1, q2, q3] = view.questions;
          wrongQuestion = q3!.id;
          const pick = (id: string, correct: boolean) => ({ questionId: id, selected: correct ? key.get(id)!.correct_answer : (key.get(id)!.correct_answer + 1) % key.get(id)!.options.length });
          const save = await api(tokenA, "PUT", `/api/quiz/attempts/${attemptId}/answers`, { answers: [pick(q1!.id, true)] });
          expect(save.statusCode).toBe(200);
          expect(save.body).not.toMatch(/correct|explanation/i);
          const reloaded = json(await api(tokenA, "GET", `/api/quiz/attempts/${attemptId}`));
          expect(reloaded.answers[q1!.id]).toBe(key.get(q1!.id)!.correct_answer); // the saved answer came back after a "refresh"
          expect((await api(tokenA, "PUT", `/api/quiz/attempts/${attemptId}/answers`, { answers: [{ questionId: "00000000-0000-4000-8000-000000000000", selected: 0 }] })).statusCode).toBe(400);
          // result is refused until submitted
          expect((await api(tokenA, "GET", `/api/quiz/attempts/${attemptId}/result`)).statusCode).toBe(409);
          // submit: 2 right, 1 wrong
          const submit = await api(tokenA, "POST", `/api/quiz/attempts/${attemptId}/submit`, { answers: [pick(q1!.id, true), pick(q2!.id, true), pick(q3!.id, false)] });
          expect(submit.statusCode).toBe(200);
          const r = json(submit);
          expect(r.attempt).toMatchObject({ status: "submitted", score: 2, total: 3, correct: 2, incorrect: 1, unanswered: 0 });
          expect(r.attempt.percentage).toBeCloseTo(66.7, 0);
          const miss = r.review.find((x: { id: string }) => x.id === q3!.id);
          expect(miss.isCorrect).toBe(false);
          expect(typeof miss.explanation).toBe("string"); // the review (after submitting) is where the explanation appears
        });

        await step("a second submit does not double-count or change the score", async () => {
          const again = await api(tokenA, "POST", `/api/quiz/attempts/${attemptId}/submit`, {});
          expect([200, 409]).toContain(again.statusCode);
          await priv();
          const [c] = (await tx.execute(sql`select count(*)::int as n, max(score) as s from public.quiz_attempts where quiz_id = ${quizId} and user_id = ${A} and status = 'submitted'`)) as unknown as Array<{ n: number; s: number }>;
          expect(c).toEqual({ n: 1, s: 2 });
          const result = json(await api(tokenA, "GET", `/api/quiz/attempts/${attemptId}/result`));
          expect(result.attempt.score).toBe(2);
        });

        /* ------------------------------------------------------------ study plan */
        await step("a plan with invalid input is refused with clear messages (past exam date, tiny/huge time, no subject, bad target)", async () => {
          const ok = { title: "Boards", examDate: isoDay(14), targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", subjects: [{ name: "Biology", priority: "high", topics: ["Photosynthesis"] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" };
          const cases: Array<[string, Record<string, unknown>, RegExp]> = [
            ["past exam date", { examDate: isoDay(-3) }, /future|after|today|exam/i],
            ["5 minutes a day", { minutesPerDay: 5 }, /15 minutes/i],
            ["20 hours a day", { minutesPerDay: 1200 }, /8 hours/i],
            ["no subject", { subjects: [] }, /subject/i],
            ["target score 150", { targetScore: 150 }, /./],
            ["missing title", { title: "" }, /name/i],
            ["bad date text", { examDate: "tomorrow" }, /./],
          ];
          for (const [label, over, message] of cases) {
            const res = await api(tokenA, "POST", "/api/study-plans/generate", { ...ok, ...over });
            expect(res.statusCode, label).toBe(400);
            expect(json(res).message, label).toMatch(message);
          }
        });

        await step("create a real plan, see its sessions, start and complete today's session", async () => {
          const res = await api(tokenA, "POST", "/api/study-plans/generate", { title: "Boards", examDate: isoDay(14), targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", subjects: [{ name: "Biology", priority: "high", topics: ["Photosynthesis"] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" });
          expect(res.statusCode).toBe(202);
          planId = json(res).plan.id;
          await app.planner.whenIdle();
          const list = json(await api(tokenA, "GET", "/api/study-plans"));
          expect(list.activePlanId).toBe(planId);
          const detail = json(await api(tokenA, "GET", `/api/study-plans/${planId}`));
          const today = isoDay(0);
          const todays = detail.sessions.filter((s: { date: string }) => s.date === today);
          expect(todays.length).toBeGreaterThan(0);
          sessionId = todays[0].id;
          const dash1 = dashboardSchema.parse(json(await api(tokenA, "GET", "/api/dashboard")));
          expect(dash1.plan.length).toBeGreaterThan(0);
          expect((await api(tokenA, "POST", `/api/study-sessions/${sessionId}/start`)).statusCode).toBe(200);
          const dash2 = dashboardSchema.parse(json(await api(tokenA, "GET", "/api/dashboard")));
          expect(dash2.resume).toMatchObject({ kind: "session", eyebrow: "Study session in progress" });
          expect((await api(tokenA, "POST", `/api/study-sessions/${sessionId}/complete`)).statusCode).toBe(200);
          // completing twice must not double count
          expect((await api(tokenA, "POST", `/api/study-sessions/${sessionId}/complete`)).statusCode).toBeGreaterThanOrEqual(400);
        });

        await step("abuse protection: hammering an expensive route from ONE client is cut off with a calm 429 before it can reach the AI", async () => {
          const same = "203.0.113.77";
          const before = rec.requests.length;
          const codes: number[] = [];
          for (let i = 0; i < 25; i++) codes.push((await app.inject({ method: "POST", url: "/api/study-plans/generate", headers: hdr(tokenA), remoteAddress: same, payload: { title: "" } })).statusCode);
          expect(codes.slice(0, 3)).toEqual([400, 400, 400]);
          expect(codes).toContain(429);
          const limited = await app.inject({ method: "POST", url: "/api/study-plans/generate", headers: hdr(tokenA), remoteAddress: same, payload: { title: "" } });
          expect(limited.json()).toMatchObject({ error: "request_error", message: expect.stringMatching(/too many requests/i) });
          expect(rec.requests.length).toBe(before);
        });

        /* ------------------------------------------------------------ viva grounded in the note */
        await step("viva from the document: the question does not reveal its key points; evaluation reveals them AFTER; completes with a computed score", async () => {
          const res = await api(tokenA, "POST", "/api/viva/sessions", { subject: "Biology", topic: "photosynthesis chloroplasts", difficulty: "easy", questionCount: 3, sourceType: "document", documentId: noteId });
          expect(res.statusCode).toBe(201);
          let d = json(res);
          vivaId = d.session.id;
          expect(d.session).toMatchObject({ sourceType: "document", documentId: noteId, status: "in_progress" });
          expect(d.questions[0].keyPoints).toBeNull(); // the secret stays secret before answering
          expect(d.questions[0].source).toMatchObject({ documentId: noteId });
          vivaQuestionId = d.questions[0].id;
          const asked = rec.requests.filter((r) => r.kind === "generate").at(-1)!;
          expect(asked.system).toContain("<study_material>");
          expect(/chloroplast|photosynthesis/i.test(asked.system)).toBe(true);

          for (let i = 0; i < 3; i++) {
            const current = d.questions.at(-1);
            const ans = await api(tokenA, "POST", `/api/viva/sessions/${vivaId}/answer`, { questionId: current.id, answer: "Photosynthesis happens in the chloroplasts, where chlorophyll absorbs sunlight and the Calvin cycle builds glucose from carbon dioxide." });
            expect(ans.statusCode).toBe(200);
            d = json(ans);
            const answered = d.questions.at(-1);
            expect(answered.answer.score).toBeGreaterThanOrEqual(0);
            expect(answered.keyPoints).not.toBeNull(); // revealed only now
            if (i < 2) {
              const nxt = await api(tokenA, "POST", `/api/viva/sessions/${vivaId}/next`);
              expect(nxt.statusCode).toBe(200);
              d = json(nxt);
              expect(d.questions.at(-1).keyPoints).toBeNull();
            }
          }
          expect(d.session).toMatchObject({ status: "completed" });
          const scores = d.questions.map((q: { answer: { score: number } }) => q.answer.score);
          const mean = Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 10) / 10;
          expect(d.session.score).toBeCloseTo(mean, 1); // the server computes it from the answers, not the model
          // an answered question cannot be answered again; a completed viva cannot get a "next"
          expect((await api(tokenA, "POST", `/api/viva/sessions/${vivaId}/answer`, { questionId: vivaQuestionId, answer: "again" })).statusCode).toBeGreaterThanOrEqual(400);
          expect((await api(tokenA, "POST", `/api/viva/sessions/${vivaId}/next`)).statusCode).toBeGreaterThanOrEqual(400);
        });

        /* ------------------------------------------------------------ progress vs the database */
        await step("Progress equals what is really in the database (no double counting, right user, right maths)", async () => {
          const p = progressResponseSchema.parse(json(await api(tokenA, "GET", "/api/progress/summary?range=30d")));
          await priv();
          const [att] = (await tx.execute(sql`select count(*)::int as n, avg(percentage)::float as avg, sum(score)::int as correct, sum(total)::int as total from public.quiz_attempts where user_id = ${A} and status in ('submitted','expired')`)) as unknown as Array<{ n: number; avg: number; correct: number; total: number }>;
          const [study] = (await tx.execute(sql`select count(*)::int as n, coalesce(sum(duration_minutes),0)::int as minutes from public.study_sessions where user_id = ${A} and status = 'completed'`)) as unknown as Array<{ n: number; minutes: number }>;
          const [viva] = (await tx.execute(sql`select count(*)::int as n, avg(score)::float as avg from public.viva_sessions where user_id = ${A} and status = 'completed'`)) as unknown as Array<{ n: number; avg: number }>;
          expect(p.quiz.attemptsCompleted).toBe(att!.n);
          expect(p.quiz.averageScore).toBeCloseTo(att!.avg, 0);
          expect(p.quiz.questions).toBe(att!.total);
          expect(p.quiz.correct).toBe(att!.correct);
          expect(p.studyTime.completedSessions).toBe(study!.n);
          expect(p.studyTime.totalMinutes).toBe(study!.minutes);
          expect(p.viva.sessionsCompleted).toBe(viva!.n);
          expect(p.viva.averageScore).toBeCloseTo(viva!.avg, 0);
          expect(p.streak.current).toBe(1); // one study day: today
          expect(p.today).toBe(isoDay(0));
          // activity: one row per finished quiz and per completed session, none duplicated
          expect(p.activity.filter((a) => a.type === "quiz_completed")).toHaveLength(att!.n);
          expect(p.activity.filter((a) => a.type === "session_completed")).toHaveLength(study!.n);
          expect(new Set(p.activity.map((a) => a.id)).size).toBe(p.activity.length);
          // topic accuracy sums to the question totals
          expect(p.topics.reduce((n, t) => n + t.total, 0)).toBeLessThanOrEqual(att!.total);
        });

        /* ------------------------------------------------------------ recommendations are real */
        await step("recommendations only state facts that are in the database, and their buttons keep the topic", async () => {
          const r = recommendationsResponseSchema.parse(json(await api(tokenA, "GET", "/api/recommendations?limit=10")));
          await priv();
          const answers = (await tx.execute(sql`
            select lower(btrim(q.topic)) as topic, count(*)::int as questions, count(*) filter (where a.is_correct)::int as correct
            from public.quiz_attempts t
            join public.quiz_questions q on q.quiz_id = t.quiz_id
            left join public.quiz_answers a on a.attempt_id = t.id and a.question_id = q.id
            where t.user_id = ${A} and t.status in ('submitted','expired') and q.topic is not null
            group by 1`)) as unknown as Array<{ topic: string; questions: number; correct: number }>;
          const byTopic = new Map(answers.map((x) => [x.topic, x]));
          for (const rec of r.recommendations) {
            const topic = rec.topic?.trim().toLowerCase();
            if (topic && rec.facts.questions > 0) {
              const real = byTopic.get(topic);
              expect(real, `recommendation for "${rec.topic}" must have quiz data`).toBeDefined();
              expect(rec.facts.questions).toBe(real!.questions);
              if (rec.facts.accuracy !== null) expect(rec.facts.accuracy).toBeCloseTo((real!.correct / real!.questions) * 100, 0);
            }
            for (const a of rec.actions) if (a.topic) expect(a.topic.toLowerCase()).toBe(topic);
            expect(rec.reason).toMatch(/\S/);
          }
        });

        /* ------------------------------------------------------------ search, notifications, dashboard */
        await step("search finds the student's own note, quiz and topics; notifications show real results; dashboard reflects it all", async () => {
          const s = searchResponseSchema.parse(json(await api(tokenA, "GET", "/api/search?q=photosyn")));
          expect(s.documents.map((d) => d.id)).toContain(noteId);
          expect(s.documents.find((d) => d.id === noteId)!.href).toBe(`/notes/${noteId}`);
          const n = notificationsResponseSchema.parse(json(await api(tokenA, "GET", "/api/notifications")));
          const kinds = n.notifications.map((x) => x.kind);
          expect(kinds).toContain("quiz_result");
          expect(kinds).toContain("viva_result");
          expect(n.notifications.find((x) => x.kind === "quiz_result")!.id).toBe(`quiz_result:${attemptId}`);
          const d = dashboardSchema.parse(json(await api(tokenA, "GET", "/api/dashboard")));
          expect(d.today.studyMinutes).toBeGreaterThan(0);
          expect(d.today.quizAveragePercent).toBe(67);
          expect(d.today.streakDays).toBe(1);
          expect(d.progress?.viva?.completedCount).toBe(1);
          expect(d.activity.map((a) => a.type)).toEqual(expect.arrayContaining(["quiz", "note", "tutor"]));
        });

        /* ================================================================== account isolation: B vs every A resource */
        await step("B sees NOTHING of A in any list, search, notification, dashboard, progress or recommendation", async () => {
          const lists = ["/api/notes", "/api/tutor/conversations", "/api/quiz", "/api/quiz/attempts", "/api/study-plans", "/api/viva/sessions"];
          for (const url of lists) {
            const body = (await api(tokenB, "GET", url)).body;
            for (const id of [noteId, convId, quizId, attemptId, planId, sessionId, vivaId]) expect(body, `${url} leaked ${id}`).not.toContain(id);
            expect(body).not.toMatch(/photosynthesis|E2E Alice/i);
          }
          expect(searchResponseSchema.parse(json(await api(tokenB, "GET", "/api/search?q=photosyn"))).documents).toEqual([]);
          expect(searchResponseSchema.parse(json(await api(tokenB, "GET", "/api/search?q=biology"))).topics).toEqual([]);
          expect(notificationsResponseSchema.parse(json(await api(tokenB, "GET", "/api/notifications"))).notifications).toEqual([]);
          const dash = dashboardSchema.parse(json(await api(tokenB, "GET", "/api/dashboard")));
          expect(dash.profile.displayName).toBe("E2E Bob");
          expect(dash.activity).toEqual([]);
          expect(dash.plan).toEqual([]);
          expect(dash.resume ?? null).toBeNull();
          const prog = progressResponseSchema.parse(json(await api(tokenB, "GET", "/api/progress/summary?range=all")));
          expect([prog.quiz.attemptsCompleted, prog.studyTime.completedSessions, prog.viva.sessionsCompleted]).toEqual([0, 0, 0]);
          expect(recommendationsResponseSchema.parse(json(await api(tokenB, "GET", "/api/recommendations"))).recommendations).toEqual([]);
          const me = json(await api(tokenB, "GET", "/api/me"));
          expect(me.profile.id).toBe(B);
        });

        await step("B cannot read or change any single A resource by its id (every route answers 404, none answers with A's data)", async () => {
          const fake = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
          const probes: Array<[string, "GET" | "POST" | "PUT" | "PATCH" | "DELETE", string, unknown?]> = [
            ["note", "GET", `/api/notes/${noteId}`],
            ["note content", "GET", `/api/notes/${noteId}/content`],
            ["note index", "GET", `/api/notes/${noteId}/index-status`],
            ["note chat", "GET", `/api/notes/${noteId}/conversation`],
            ["note reprocess", "POST", `/api/notes/${noteId}/process`],
            ["note assistant", "POST", `/api/notes/${noteId}/assistant`, { action: "summarize" }],
            ["note delete", "DELETE", `/api/notes/${noteId}`],
            ["conversation", "GET", `/api/tutor/conversations/${convId}`],
            ["conversation rename", "PATCH", `/api/tutor/conversations/${convId}`, { title: "hijacked" }],
            ["conversation send", "POST", `/api/tutor/conversations/${convId}/messages`, { content: "hello" }],
            ["conversation regenerate", "POST", `/api/tutor/conversations/${convId}/regenerate`],
            ["conversation delete", "DELETE", `/api/tutor/conversations/${convId}`],
            ["quiz", "GET", `/api/quiz/${quizId}`],
            ["quiz start", "POST", `/api/quiz/${quizId}/start`],
            ["quiz retry", "POST", `/api/quiz/${quizId}/retry`],
            ["quiz regenerate", "POST", `/api/quiz/${quizId}/regenerate`],
            ["attempt", "GET", `/api/quiz/attempts/${attemptId}`],
            ["attempt answers", "PUT", `/api/quiz/attempts/${attemptId}/answers`, { answers: [] }],
            ["attempt submit", "POST", `/api/quiz/attempts/${attemptId}/submit`, {}],
            ["attempt result", "GET", `/api/quiz/attempts/${attemptId}/result`],
            ["plan", "GET", `/api/study-plans/${planId}`],
            ["plan edit", "PATCH", `/api/study-plans/${planId}`, { title: "hijacked" }],
            ["plan activate", "POST", `/api/study-plans/${planId}/activate`],
            ["plan regenerate", "POST", `/api/study-plans/${planId}/regenerate`, {}],
            ["session start", "POST", `/api/study-sessions/${sessionId}/start`],
            ["session complete", "POST", `/api/study-sessions/${sessionId}/complete`],
            ["session skip", "POST", `/api/study-sessions/${sessionId}/skip`],
            ["viva", "GET", `/api/viva/sessions/${vivaId}`],
            ["viva answer", "POST", `/api/viva/sessions/${vivaId}/answer`, { questionId: vivaQuestionId, answer: "x" }],
            ["viva next", "POST", `/api/viva/sessions/${vivaId}/next`],
            ["viva abandon", "POST", `/api/viva/sessions/${vivaId}/abandon`],
            // guessed UUIDs behave exactly the same
            ["guessed note", "GET", `/api/notes/${fake}`],
            ["guessed quiz", "GET", `/api/quiz/${fake}`],
            ["guessed viva", "GET", `/api/viva/sessions/${fake}`],
          ];
          for (const [label, method, url, payload] of probes) {
            const res = await api(tokenB, method, url, payload);
            expect(res.statusCode, `${label}: ${method} ${url}`).toBe(404);
            expect(res.body, label).not.toMatch(/photosynthesis|E2E Alice|chloroplast/i);
          }
          // A's data is untouched by all of that
          expect(json(await api(tokenA, "GET", `/api/study-plans/${planId}`)).plan.title).toBe("Boards");
          expect(json(await api(tokenA, "GET", `/api/tutor/conversations/${convId}`)).conversation.title).not.toBe("hijacked");
          expect(json(await api(tokenA, "GET", `/api/notes/${noteId}`)).note.status).toBe("ready");
        });

        await step("B cannot AIM their own requests at A's documents (tutor scope, quiz source, viva source) and malformed ids are rejected", async () => {
          const bConv = json(await api(tokenB, "POST", "/api/tutor/conversations", {})).conversation.id;
          const before = rec.requests.length;
          expect((await api(tokenB, "POST", `/api/tutor/conversations/${bConv}/messages`, { content: "photosynthesis?", documentId: noteId })).statusCode).toBe(404);
          expect((await api(tokenB, "POST", "/api/quiz/generate", { source: { type: "notes", documentIds: [noteId] }, difficulty: "easy", count: 3, questionTypes: ["mcq"] })).statusCode).toBe(404);
          expect((await api(tokenB, "POST", "/api/viva/sessions", { subject: "Bio", topic: "photosynthesis", difficulty: "easy", questionCount: 3, sourceType: "document", documentId: noteId })).statusCode).toBe(404);
          expect((await api(tokenB, "POST", "/api/viva/sessions", { subject: "Bio", topic: "photosynthesis", difficulty: "easy", questionCount: 3, sourceType: "notes" })).statusCode).toBe(422); // B has no notes: nothing found, nothing leaked
          expect(rec.requests.length).toBe(before); // none of that reached the AI
          for (const url of ["/api/notes/not-a-uuid", "/api/quiz/123", "/api/viva/sessions/x'or'1'='1", "/api/study-plans/..%2f..%2fetc"]) {
            expect([400, 404], url).toContain((await api(tokenB, "GET", url)).statusCode);
          }
        });

        await step("no token, a garbage token, an expired token, a token from another signer, and a non-user (anon) token are all refused on every area", async () => {
          const other = await generateKeyPair("ES256");
          const expired = await sign({ sub: A, role: "authenticated" }, undefined, Math.floor(Date.now() / 1000) - 60);
          const foreign = await sign({ sub: A, role: "authenticated" }, other.privateKey);
          const anon = await sign({ sub: A, role: "anon" });
          const routes = ["/api/me", "/api/dashboard", "/api/notes", "/api/tutor/conversations", "/api/quiz", "/api/study-plans", "/api/progress/summary", "/api/viva/sessions", "/api/recommendations", "/api/search?q=photo", "/api/notifications", `/api/notes/${noteId}`];
          const bad: Array<Record<string, string>> = [{}, { authorization: "Bearer garbage" }, { authorization: "Bearer " }, { authorization: "Basic abc" }, { authorization: `Bearer ${expired}` }, { authorization: `Bearer ${foreign}` }, { authorization: `Bearer ${anon}` }];
          for (const headers of bad) {
            for (const url of routes) {
              const res = await app.inject({ method: "GET", url, headers, remoteAddress: from() });
              expect(res.statusCode, `${url} with ${JSON.stringify(headers).slice(0, 40)}`).toBe(401);
              expect(res.body).not.toMatch(/photosynthesis|E2E/i);
            }
          }
        });

        /* ================================================================== the database itself, whatever the API does */
        const actAs = async (uid: string | null) => {
          await priv();
          if (uid) {
            await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`);
            await tx.execute(sql`set local role authenticated`);
          } else {
            await tx.execute(sql`select set_config('request.jwt.claims', '', true)`);
            await tx.execute(sql`set local role anon`);
          }
        };
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

        await step("RLS: for EVERY table that holds a student's data, B reads only their own rows, A reads A's, and anon reads nothing", async () => {
          await priv();
          const tables = ((await tx.execute(sql`
            select c.relname as t, exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'user_id') as has_user_id
            from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by c.relname`)) as unknown as Array<{ t: string; has_user_id: boolean }>).map((r) => r.t);
          // every public table has RLS switched on
          const off = (await tx.execute(sql`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`)) as unknown as Array<{ relname: string }>;
          expect(off.map((r) => r.relname)).toEqual([]);
          const count = async (uid: string | null, t: string): Promise<number> => {
            await actAs(uid);
            const rows = (await tx.execute(sql.raw(`select count(*)::int as n from public.${t}`))) as unknown as Array<{ n: number }>;
            return rows[0]!.n;
          };
          const withData: string[] = [];
          for (const t of tables) {
            await priv();
            const owner = t === "student_profiles" ? "id" : "user_id";
            const [total] = (await tx.execute(sql.raw(`select count(*) filter (where ${owner} = '${A}')::int as a, count(*) filter (where ${owner} = '${B}')::int as b, count(*)::int as all from public.${t}`))) as unknown as Array<{ a: number; b: number; all: number }>;
            const seenByA = await count(A, t);
            const seenByB = await count(B, t);
            // students only ever see THEIR OWN rows: A's count is A's rows, B's count is B's rows (other users' real rows are invisible)
            expect(seenByA, `${t}: A should see exactly A's rows`).toBe(total!.a);
            expect(seenByB, `${t}: B should see exactly B's rows`).toBe(total!.b);
            if (total!.a > 0) withData.push(t);
            await actAs(null);
            await rejected(sql.raw(`select count(*) from public.${t}`), /permission denied|row-level security/i); // not signed in: nothing
          }
          await priv();
          // the check is not vacuous: A really has data in every part of the product
          for (const t of ["documents", "document_chunks", "conversations", "messages", "quizzes", "quiz_questions", "quiz_sources", "quiz_attempts", "quiz_answers", "study_plans", "study_sessions", "viva_sessions", "viva_answers", "student_profiles"]) {
            expect(withData, `A should have rows in ${t}`).toContain(t);
          }
        });

        await step("RLS: B cannot write to, re-assign or delete A's rows at the database level (and cannot forge ownership)", async () => {
          const targets: Array<[string, string]> = [
            ["documents", "title = 'x'"],
            ["conversations", "title = 'x'"],
            ["quizzes", "title = 'x'"],
            ["quiz_attempts", "score = 99"],
            ["study_plans", "title = 'x'"],
            ["study_sessions", "status = 'completed'"],
            ["viva_sessions", "score = 100"],
            ["student_profiles", "display_name = 'hijacked'"],
          ];
          // A fingerprint of A's rows in each table: whatever B tries (and whether the database refuses loudly or quietly matches zero rows),
          // A's data must be byte-for-byte what it was.
          const fingerprint = async (t: string) => {
            await priv();
            const owner = t === "student_profiles" ? "id" : "user_id";
            const [r] = (await tx.execute(sql.raw(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h, count(*)::int as n from public.${t} x where ${owner} = '${A}'`))) as unknown as Array<{ h: string; n: number }>;
            return r!;
          };
          const before = new Map<string, { h: string; n: number }>();
          for (const [t] of targets) before.set(t, await fingerprint(t));
          for (const [t, set] of targets) {
            await actAs(B);
            // UPDATE: either refused (no privilege) or allowed on B's OWN rows only (e.g. their profile name) - never on A's.
            await tx.transaction(async (sp) => sp.execute(sql.raw(`update public.${t} set ${set}`))).catch((err: Error & { cause?: Error }) => expect(err.cause?.message ?? err.message).toMatch(/permission denied|row-level security/i));
            await rejected(sql.raw(`delete from public.${t}`), /permission denied|row-level security/i); // nobody deletes through the student role
          }
          for (const [t] of targets) expect(await fingerprint(t), `${t}: A's rows changed`).toEqual(before.get(t));
          await actAs(B);
          await rejected(sql`insert into public.documents (user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${A}, 't', 't.md', 'md', 'text/markdown', 1, ${"c".repeat(64)}, ${`${A}/${noteId}/original.md`})`, /permission denied|row-level security/i);
          await rejected(sql`insert into public.messages (conversation_id, user_id, role, content) values (${convId}, ${A}, 'user', 'forged')`, /permission denied|row-level security|violates/i);
          await priv();
          const [still] = (await tx.execute(sql`select (select title from public.study_plans where id = ${planId}) as plan, (select score from public.quiz_attempts where id = ${attemptId}) as score, (select display_name from public.student_profiles where id = ${A}) as name`)) as unknown as Array<{ plan: string; score: number; name: string }>;
          expect(still).toEqual({ plan: "Boards", score: 2, name: "E2E Alice" });
        });

        await step("RLS: the answer key (quiz correct answers, viva key points) is not readable by a student's database role at all", async () => {
          await actAs(A);
          await rejected(sql`select correct_answer from public.quiz_questions`, /permission denied/i);
          await rejected(sql`select explanation from public.quiz_questions`, /permission denied/i);
          await rejected(sql`select key_points from public.viva_questions`, /permission denied/i);
          await rejected(sql`select source_ref from public.viva_questions`, /permission denied/i);
          await priv();
        });

        await step("STORAGE: the notes bucket is private; a student reads/writes only inside their own folder; anon gets nothing", async () => {
          await priv();
          const [bucket] = (await tx.execute(sql`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'notes'`)) as unknown as Array<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>;
          expect(bucket!.public).toBe(false);
          expect(Number(bucket!.file_size_limit)).toBe(10 * 1024 * 1024);
          expect(bucket!.allowed_mime_types).toEqual(["application/pdf", "text/plain", "text/markdown"]);
          await tx.execute(sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', ${`${A}/${noteId}/original.pdf`}, ${A}), ('notes', ${`${B}/${"1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b"}/original.pdf`}, ${B})`);
          const visible = async (uid: string | null) => {
            await actAs(uid);
            return ((await tx.execute(sql`select name from storage.objects where bucket_id = 'notes'`)) as unknown as Array<{ name: string }>).map((r) => r.name);
          };
          expect(await visible(A)).toEqual([`${A}/${noteId}/original.pdf`]);
          expect((await visible(B)).every((n) => n.startsWith(`${B}/`))).toBe(true);
          expect((await visible(B)).some((n) => n.startsWith(`${A}/`))).toBe(false);
          await actAs(null);
          const anonRows = await tx.transaction(async (sp) => sp.execute(sql`select name from storage.objects where bucket_id = 'notes'`)).catch(() => []);
          expect((anonRows as unknown as unknown[]).length).toBe(0);
          await actAs(B);
          await rejected(sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', ${`${A}/${"2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c"}/original.pdf`}, ${B})`, /row-level security|violates|permission denied/i);
          await actAs(A);
          await rejected(sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', ${`${B}/${"3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d"}/original.pdf`}, ${A})`, /row-level security|violates|permission denied/i);
          await rejected(sql`delete from storage.objects where bucket_id = 'notes'`, /permission denied|row-level security|not allowed/i); // students cannot delete files
          // No UPDATE policy exists: Postgres RLS silently matches zero rows (or errors). Either way the file keeps its name.
          await tx.transaction(async (sp) => sp.execute(sql`update storage.objects set name = ${`${A}/x/original.pdf`} where bucket_id = 'notes'`)).catch(() => undefined);
          expect(await visible(A)).toEqual([`${A}/${noteId}/original.pdf`]);
          await priv();
        });

        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    // eslint-disable-next-line no-console
    console.log(`\nJOURNEY STEPS\n${log.join("\n")}`);
  }, 900_000);
});
