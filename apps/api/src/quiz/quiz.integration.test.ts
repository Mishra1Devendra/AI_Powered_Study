import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { chunkPages } from "../notes/chunker.js";
import { createNotesRepository } from "../notes/repository.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createQuizRepository } from "./repository.js";
import { createQuizService } from "./service.js";

/**
 * Live-database tests for AI Quiz. Everything runs inside ONE transaction that is ALWAYS rolled
 * back: no users, notes, quizzes, attempts or answers are ever persisted, and no real account is
 * touched. Two synthetic users are inserted into auth.users inside it.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QA = "c0000000-0000-4000-8000-00000000000a";
const QB = "c0000000-0000-4000-8000-00000000000b";
const QUA = "e0000000-0000-4000-8000-00000000000a";
const QUB = "e0000000-0000-4000-8000-00000000000b";
const AT_A = "f0000000-0000-4000-8000-00000000000a";
const AT_B = "f0000000-0000-4000-8000-00000000000b";
const DOC_A = "d0000000-0000-4000-8000-00000000000a";
const ROLLBACK = new Error("rollback");

const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rows = <T>(r: unknown) => r as unknown as T[];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'quiz-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'quiz-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      await fn(tx);
      throw ROLLBACK;
    }),
  ).rejects.toBe(ROLLBACK);
}

async function actAs(tx: Tx, uid: string | null) {
  await tx.execute(sql`reset role`);
  if (uid) {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`);
    await tx.execute(sql`set local role authenticated`);
  } else {
    await tx.execute(sql`select set_config('request.jwt.claims', '', true)`);
    await tx.execute(sql`set local role anon`);
  }
}

async function expectRejected(tx: Tx, query: ReturnType<typeof sql>, message: RegExp) {
  try {
    await tx.transaction(async (sp) => sp.execute(query));
  } catch (err) {
    const e = err as Error & { cause?: Error };
    expect(e.cause?.message ?? e.message).toMatch(message);
    return;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded");
}

const DENIED = /permission denied|row-level security/i;

/** Server-side (privileged) inserts, as the API does after resolving the student from their token. */
async function seedQuiz(tx: Tx, userId: string, quizId: string, questionId: string, attemptId: string) {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`
    insert into public.quizzes (id, user_id, title, source_type, subject, difficulty, question_count, question_types, status)
    values (${quizId}, ${userId}, 'Heat quiz', 'topic', 'Physics', 'easy', 1, array['mcq'], 'ready')`);
  await tx.execute(sql`
    insert into public.quiz_questions (id, quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, topic, difficulty)
    values (${questionId}, ${quizId}, ${userId}, 0, 'mcq', 'What carries heat by electromagnetic waves?', '["Radiation","Convection","Conduction","Insulation"]'::jsonb, '0'::jsonb, 'Radiation transfers heat as waves, with no medium.', 'Heat', 'easy')`);
  await tx.execute(sql`
    insert into public.quiz_attempts (id, quiz_id, user_id, question_order)
    values (${attemptId}, ${quizId}, ${userId}, array[${questionId}]::uuid[])`);
  await tx.execute(sql`
    insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer)
    values (${attemptId}, ${quizId}, ${questionId}, ${userId}, 1)`);
}

const live = !!process.env.DATABASE_URL;
const TABLES = ["quizzes", "quiz_sources", "quiz_questions", "quiz_attempts", "quiz_answers"];
const TABLE_LIST = sql.raw(TABLES.map((t) => `'${t}'`).join(", "));

describe.skipIf(!live)("quiz tables: privileges and Row Level Security (live DB, rolled back)", () => {
  it("RLS is on for every quiz table", async () => {
    const info = rows<{ rel: string; rls: boolean }>(
      await db.execute(sql`select relname as rel, relrowsecurity as rls from pg_class where oid = any (array['public.quizzes'::regclass,'public.quiz_sources'::regclass,'public.quiz_questions'::regclass,'public.quiz_attempts'::regclass,'public.quiz_answers'::regclass])`),
    );
    expect(info).toHaveLength(5);
    expect(info.every((r) => r.rls)).toBe(true);
  });

  it("students can only READ; anonymous visitors can do nothing; the answer key columns are not readable", async () => {
    const tableGrants = rows<{ t: string; p: string; g: string }>(
      await db.execute(sql`select table_name t, privilege_type p, grantee g from information_schema.role_table_grants where table_schema='public' and table_name in (${TABLE_LIST}) and grantee in ('anon','authenticated')`),
    );
    expect(tableGrants.map((x) => `${x.g}:${x.t}:${x.p}`).sort()).toEqual([
      "authenticated:quiz_answers:SELECT",
      "authenticated:quiz_attempts:SELECT",
      "authenticated:quizzes:SELECT",
      "authenticated:quiz_sources:SELECT",
    ].sort());

    const cols = rows<{ c: string; p: string }>(
      await db.execute(sql`select column_name c, privilege_type p from information_schema.column_privileges where table_schema='public' and table_name='quiz_questions' and grantee='authenticated'`),
    );
    expect(cols.every((c) => c.p === "SELECT")).toBe(true); // no column is writable
    expect(cols.map((c) => c.c).sort()).toEqual(["created_at", "difficulty", "id", "options", "question_order", "question_text", "question_type", "quiz_id", "topic", "user_id"]);
    for (const secret of ["correct_answer", "explanation", "source_ref"]) expect(cols.map((c) => c.c)).not.toContain(secret);

    const writes = rows<{ n: number }>(
      await db.execute(sql`select count(*)::int n from information_schema.column_privileges where table_schema='public' and table_name in (${TABLE_LIST}) and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE')`),
    );
    expect(writes[0]!.n).toBe(0);
  });

  it("a student cannot read the answer key, however they ask (select list, *, expressions, joins, views of it)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedQuiz(tx, A, QA, QUA, AT_A);
      await actAs(tx, A);
      // allowed: what the player needs
      const ok = rows<{ question_text: string; options: string[] }>(await tx.execute(sql`select question_text, options from public.quiz_questions where quiz_id = ${QA}`));
      expect(ok).toHaveLength(1);
      expect(ok[0]!.options).toHaveLength(4);
      // not allowed: the key, in every form
      for (const q of [
        sql`select correct_answer from public.quiz_questions`,
        sql`select explanation from public.quiz_questions`,
        sql`select source_ref from public.quiz_questions`,
        sql`select * from public.quiz_questions`,
        sql`select q.* from public.quiz_questions q`,
        sql`select to_jsonb(q) from public.quiz_questions q`,
        sql`select count(*) from public.quiz_questions where correct_answer = '0'::jsonb`,
        sql`select 1 from public.quiz_questions order by correct_answer`,
        sql`select question_text from public.quiz_questions where explanation like '%Radiation%'`,
      ]) {
        await expectRejected(tx, q, DENIED);
      }
    });
  });

  it("a student cannot create, change or delete quiz data directly (generation, answers and grading are server-only)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedQuiz(tx, A, QA, QUA, AT_A);
      await actAs(tx, A);
      const attempts: Array<[string, ReturnType<typeof sql>]> = [
        ["insert quiz", sql`insert into public.quizzes (user_id, title, source_type, subject, difficulty, question_count, question_types) values (${A}, 'x', 'topic', 'y', 'easy', 1, array['mcq'])`],
        ["insert question", sql`insert into public.quiz_questions (quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, difficulty) values (${QA}, ${A}, 5, 'mcq', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'easy')`],
        ["insert attempt", sql`insert into public.quiz_attempts (quiz_id, user_id, question_order) values (${QA}, ${A}, array[]::uuid[])`],
        ["insert answer", sql`insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer) values (${AT_A}, ${QA}, ${QUA}, ${A}, 0)`],
        ["fake a perfect score", sql`update public.quiz_attempts set score = 10, total = 10, percentage = 100 where id = ${AT_A}`],
        ["mark an answer correct", sql`update public.quiz_answers set is_correct = true where attempt_id = ${AT_A}`],
        ["change a question", sql`update public.quiz_questions set question_text = 'x' where id = ${QUA}`],
        ["delete a quiz", sql`delete from public.quizzes where id = ${QA}`],
        ["delete an attempt", sql`delete from public.quiz_attempts where id = ${AT_A}`],
      ];
      for (const [, q] of attempts) await expectRejected(tx, q, DENIED);
      await actAs(tx, null);
      for (const t of TABLES) await expectRejected(tx, sql.raw(`select count(*) from public.${t}`), DENIED); // anonymous: nothing at all
    });
  });

  it("a student sees only their own quizzes, questions, attempts, answers and sources", async () => {
    await inRolledBackTx(async (tx) => {
      await seedQuiz(tx, A, QA, QUA, AT_A);
      await seedQuiz(tx, B, QB, QUB, AT_B);
      await tx.execute(sql`reset role`);
      await tx.execute(sql`insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status) values (${DOC_A}, ${A}, 'Notes', 'n.md', 'md', 'upload', 'text/markdown', 10, ${"a".repeat(64)}, ${`${A}/${DOC_A}/original.md`}, 'ready')`);
      await tx.execute(sql`insert into public.quiz_sources (quiz_id, document_id, user_id) values (${QA}, ${DOC_A}, ${A})`);

      for (const [uid, mine, theirs] of [[A, QA, QB], [B, QB, QA]] as const) {
        await actAs(tx, uid);
        expect(rows<{ id: string }>(await tx.execute(sql`select id from public.quizzes`)).map((r) => r.id)).toEqual([mine]);
        expect(rows<{ id: string }>(await tx.execute(sql`select id from public.quiz_questions`))).toHaveLength(1);
        expect(rows<{ user_id: string }>(await tx.execute(sql`select user_id from public.quiz_attempts`)).map((r) => r.user_id)).toEqual([uid]);
        expect(rows<{ user_id: string }>(await tx.execute(sql`select user_id from public.quiz_answers`)).map((r) => r.user_id)).toEqual([uid]);
        expect(rows(await tx.execute(sql`select 1 from public.quizzes where id = ${theirs}`))).toHaveLength(0);
        expect(rows(await tx.execute(sql`select 1 from public.quiz_questions where quiz_id = ${theirs}`))).toHaveLength(0);
        expect(rows(await tx.execute(sql`select 1 from public.quiz_attempts where quiz_id = ${theirs}`))).toHaveLength(0);
      }
      await actAs(tx, B);
      expect(rows(await tx.execute(sql`select 1 from public.quiz_sources`))).toHaveLength(0);
      await actAs(tx, A);
      expect(rows(await tx.execute(sql`select 1 from public.quiz_sources`))).toHaveLength(1);
    });
  });

  it("composite foreign keys make cross-student and cross-quiz links impossible, even for the server", async () => {
    await inRolledBackTx(async (tx) => {
      await seedQuiz(tx, A, QA, QUA, AT_A);
      await seedQuiz(tx, B, QB, QUB, AT_B);
      await tx.execute(sql`reset role`);
      await tx.execute(sql`delete from public.quiz_answers`); // so the foreign-key check, not a unique clash, is what rejects the inserts below
      const FK = /violates foreign key constraint/;
      // an attempt by B on A's quiz
      await expectRejected(tx, sql`insert into public.quiz_attempts (quiz_id, user_id, question_order) values (${QA}, ${B}, array[]::uuid[])`, FK);
      // a question attached to someone else's quiz
      await expectRejected(tx, sql`insert into public.quiz_questions (quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, difficulty) values (${QA}, ${B}, 9, 'mcq', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'easy')`, FK);
      // B's answer recorded against A's attempt
      await expectRejected(tx, sql`insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer) values (${AT_A}, ${QA}, ${QUA}, ${B}, 0)`, FK);
      // an answer for a question that belongs to a different quiz than the attempt
      await expectRejected(tx, sql`insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer) values (${AT_B}, ${QB}, ${QUA}, ${B}, 0)`, FK);
      // a quiz sourced from someone else's note
      await tx.execute(sql`insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status) values (${DOC_A}, ${A}, 'Notes', 'n.md', 'md', 'upload', 'text/markdown', 10, ${"a".repeat(64)}, ${`${A}/${DOC_A}/original.md`}, 'ready')`);
      await expectRejected(tx, sql`insert into public.quiz_sources (quiz_id, document_id, user_id) values (${QB}, ${DOC_A}, ${B})`, FK);
    });
  });

  it("the database refuses malformed quiz data (second line of defence behind the validator)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedQuiz(tx, A, QA, QUA, AT_A);
      await tx.execute(sql`reset role`);
      const CHECK = /violates check constraint/;
      const q = (extra: ReturnType<typeof sql>) => sql`insert into public.quiz_questions (quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, difficulty) values ${extra}`;
      await expectRejected(tx, q(sql`(${QA}, ${A}, 1, 'mcq', 'Q?', '"not an array"'::jsonb, '0'::jsonb, 'e', 'easy')`), CHECK); // options must be an array
      await expectRejected(tx, q(sql`(${QA}, ${A}, 2, 'mcq', 'Q?', '["only one"]'::jsonb, '0'::jsonb, 'e', 'easy')`), CHECK); // at least 2 options
      await expectRejected(tx, q(sql`(${QA}, ${A}, 3, 'mcq', 'Q?', '["a","b"]'::jsonb, '"a"'::jsonb, 'e', 'easy')`), CHECK); // answer must be an index
      await expectRejected(tx, q(sql`(${QA}, ${A}, 4, 'mcq', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, '   ', 'easy')`), CHECK); // explanation required
      await expectRejected(tx, q(sql`(${QA}, ${A}, 5, 'mcq', '', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'easy')`), CHECK); // question required
      await expectRejected(tx, q(sql`(${QA}, ${A}, 6, 'essay', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'easy')`), CHECK);
      await expectRejected(tx, q(sql`(${QA}, ${A}, 7, 'mcq', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'mixed')`), CHECK); // a question is never "mixed"
      await expectRejected(tx, q(sql`(${QA}, ${A}, 0, 'mcq', 'Q?', '["a","b"]'::jsonb, '0'::jsonb, 'e', 'easy')`), /duplicate key/); // order is unique per quiz
      await expectRejected(tx, sql`insert into public.quiz_attempts (quiz_id, user_id, question_order) values (${QA}, ${A}, array[]::uuid[])`, /duplicate key/); // one open attempt per quiz
      await expectRejected(tx, sql`update public.quiz_attempts set status = 'submitted' where id = ${AT_A}`, CHECK); // submitted needs a time
      await expectRejected(tx, sql`update public.quiz_attempts set score = 3, total = 2, status = 'submitted', submitted_at = now() where id = ${AT_A}`, CHECK);
      await expectRejected(tx, sql`insert into public.quizzes (user_id, title, source_type, difficulty, question_count, question_types) values (${A}, 'x', 'topic', 'easy', 1, array['mcq'])`, CHECK); // topic quiz needs a subject
      await expectRejected(tx, sql`insert into public.quizzes (user_id, title, source_type, subject, difficulty, question_count, question_types) values (${A}, 'x', 'topic', 's', 'easy', 99, array['mcq'])`, CHECK);
      await expectRejected(tx, sql`insert into public.quizzes (user_id, title, source_type, subject, difficulty, question_count, question_types) values (${A}, 'x', 'topic', 's', 'easy', 5, array['essay'])`, CHECK);
    });
  });
});

describe.skipIf(!live)("AI Quiz end to end on the real database (rolled back)", () => {
  async function seedReadyNote(tx: Tx, userId: string, id: string, hash: string, database: Database) {
    await tx.execute(sql`reset role`);
    const notes = createNotesRepository(database);
    await notes.createDocument({ id, userId, title: "Biology notes", originalFilename: "bio.md", fileType: "md", source: "upload", mimeType: "text/markdown", fileSize: 100, contentHash: hash.repeat(64), storagePath: `${userId}/${id}/original.md` });
    const text = ["cells", "energy", "genes", "enzymes", "membranes", "ecology"].map((s) => `# ${s}\n\n${`The topic of ${s} matters in biology because ${s} are central. `.repeat(14)}`).join("\n\n");
    await notes.saveChunksAndMarkReady(userId, id, chunkPages([{ page: null, text }]), { pageCount: null, charCount: text.length, sourceFilename: "bio.md" });
    return notes;
  }

  // These make a few hundred statements; on a slow connection to the hosted database that takes minutes.
  const SLOW = 300_000;

  it("generate -> take -> submit -> result -> retry -> history -> regenerate, with ownership enforced by the database", async () => {
    await inRolledBackTx(async (tx) => {
      const database = tx as unknown as Database;
      const notes = await seedReadyNote(tx, A, DOC_A, "a", database);
      const service = createQuizService({ repo: createQuizRepository(database), notes, ai: new MockProvider(0) });

      // Generate from the student's own note.
      const quiz = await service.generate(A, { source: { type: "notes", documentIds: [DOC_A] }, difficulty: "mixed", count: 6, questionTypes: ["mcq", "true_false"], timeLimitMinutes: null });
      expect(quiz.status).toBe("generating");
      await service.whenIdle();
      const detail = await service.detail(A, quiz.id);
      expect(detail.quiz).toMatchObject({ status: "ready", isMock: true, sourceType: "notes", sources: [{ id: DOC_A, title: "Biology notes" }] });
      expect(detail.questions).toHaveLength(6);
      expect(JSON.stringify(detail)).not.toMatch(/correctAnswer|explanation/);

      // Another student cannot see, start or submit anything of it.
      await expect(service.detail(B, quiz.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.start(B, quiz.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.generate(B, { source: { type: "notes", documentIds: [DOC_A] }, difficulty: "easy", count: 5, questionTypes: ["mcq"], timeLimitMinutes: null })).rejects.toMatchObject({ status: 404 });
      expect((await service.list(B)).quizzes).toEqual([]);

      // Take it: save, change, then submit with the right answers for the first four.
      const view = await service.start(A, quiz.id);
      expect(view.questions).toHaveLength(6);
      await expect(service.attemptView(B, view.attempt.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.submit(B, view.attempt.id, {})).rejects.toMatchObject({ status: 404 });
      await expect(service.saveAnswers(B, view.attempt.id, { answers: [{ questionId: view.questions[0]!.id, selected: 0 }] })).rejects.toMatchObject({ status: 404 });
      await service.saveAnswers(A, view.attempt.id, { answers: [{ questionId: view.questions[0]!.id, selected: 1 }] });
      await expect(service.result(A, view.attempt.id)).rejects.toMatchObject({ code: "not_submitted" });

      // The key, read the way only the server can.
      const repo = createQuizRepository(database);
      const key = new Map((await repo.getFullQuestions(A, quiz.id)).map((q) => [q.id, q]));
      const answers = view.questions.slice(0, 4).map((q) => ({ questionId: q.id, selected: key.get(q.id)!.correctIndex }));
      const result = await service.submit(A, view.attempt.id, { answers });
      expect(result.attempt).toMatchObject({ status: "submitted", score: 4, total: 6, percentage: 66.67, correct: 4, incorrect: 0, unanswered: 2 });
      expect(result.review).toHaveLength(6);
      expect(result.topics.reduce((n, t) => n + t.total, 0)).toBe(6);

      // Duplicate submission: same stored result.
      const again = await service.submit(A, view.attempt.id, { answers: view.questions.map((q) => ({ questionId: q.id, selected: key.get(q.id)!.correctIndex })) });
      expect(again.attempt).toEqual(result.attempt);

      // Retry: a new attempt; the first is intact.
      const retry = await service.retry(A, quiz.id);
      expect(retry.attempt.id).not.toBe(view.attempt.id);
      expect((await service.result(A, view.attempt.id)).attempt.score).toBe(4);
      await service.submit(A, retry.attempt.id, {});

      // History and summary are real.
      const history = await service.history(A);
      expect(history.map((h) => h.percentage).sort()).toEqual([0, 66.67]);
      const summary = (await service.list(A)).summary;
      expect(summary).toMatchObject({ quizzesCreated: 1, attemptsCompleted: 2, averagePercentage: 33.34, bestPercentage: 66.67, questionsAnswered: 4 });
      expect((await service.history(B))).toEqual([]);
      expect((await service.list(B)).summary).toMatchObject({ attemptsCompleted: 0, averagePercentage: null });

      // Regenerate: a separate quiz with different questions.
      const next = await service.regenerate(A, quiz.id);
      await service.whenIdle();
      const nextDetail = await service.detail(A, next.id);
      expect(nextDetail.quiz.status).toBe("ready");
      const oldTexts = new Set(detail.questions.map((q) => q.text));
      expect(nextDetail.questions.filter((q) => oldTexts.has(q.text))).toHaveLength(0);
      await expect(service.regenerate(B, quiz.id)).rejects.toMatchObject({ status: 404 });
    });
  }, SLOW);

  it("a failed generation leaves no questions behind", async () => {
    await inRolledBackTx(async (tx) => {
      const database = tx as unknown as Database;
      const notes = await seedReadyNote(tx, A, DOC_A, "a", database);
      const broken = { ...new MockProvider(0), name: "ollama" as const, model: "broken", isMock: false, generateText: async () => ({ text: "garbage", provider: "ollama" as const, model: "broken", isMock: false }), streamText: new MockProvider(0).streamText.bind(new MockProvider(0)) };
      const service = createQuizService({ repo: createQuizRepository(database), notes, ai: broken });
      const quiz = await service.generate(A, { source: { type: "topic", subject: "Physics" }, difficulty: "easy", count: 5, questionTypes: ["mcq"], timeLimitMinutes: null });
      await service.whenIdle();
      const detail = await service.detail(A, quiz.id);
      expect(detail.quiz).toMatchObject({ status: "failed", error: expect.stringMatching(/Nothing was saved/) });
      expect(detail.questions).toEqual([]);
      const count = rows<{ n: number }>(await tx.execute(sql`select count(*)::int n from public.quiz_questions where quiz_id = ${quiz.id}`));
      expect(count[0]!.n).toBe(0);
    });
  }, SLOW);
});
