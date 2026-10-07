import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createVivaRepository } from "./repository.js";
import { createVivaService } from "./service.js";

/**
 * Live-database tests for AI Viva. Everything runs inside ONE transaction that is ALWAYS rolled back: no users,
 * vivas, questions or answers are ever persisted and no real account is touched. Two synthetic users are inserted
 * into auth.users inside it.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA = "d1000000-0000-4000-8000-00000000000a";
const SB = "d1000000-0000-4000-8000-00000000000b";
const QA = "d2000000-0000-4000-8000-00000000000a";
const QB = "d2000000-0000-4000-8000-00000000000b";
const QA2 = "d2000000-0000-4000-8000-0000000000a2";
const AA = "d3000000-0000-4000-8000-00000000000a";
const ROLLBACK = new Error("rollback");

const live = !!process.env.DATABASE_URL;
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
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viva-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viva-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      try {
        await fn(tx);
      } catch (err) {
        const cause = (err as { cause?: Error }).cause;
        if (cause) (err as Error).message += ` | cause: ${cause.message}`;
        throw err;
      }
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
const CHECK = /check constraint|violates|invalid input/i;

/** Server-side (privileged) inserts, as the API does after resolving the student from their token. */
async function seed(tx: Tx) {
  await tx.execute(sql`reset role`);
  const session = (id: string, user: string) =>
    tx.execute(sql`insert into public.viva_sessions (id, user_id, subject, topic, difficulty, question_count) values (${id}, ${user}, 'Chemistry', 'Rates', 'medium', 5)`);
  const question = (id: string, sessionId: string, user: string) =>
    tx.execute(sql`insert into public.viva_questions (id, session_id, user_id, question_number, question_text, concept, key_points) values (${id}, ${sessionId}, ${user}, 1, 'Why does heat speed up reactions?', 'Rate', '["energy","collisions"]'::jsonb)`);
  await session(SA, A);
  await session(SB, B);
  await question(QA, SA, A);
  await question(QB, SB, B);
  // A second, unanswered question of A's viva.
  await tx.execute(sql`insert into public.viva_questions (id, session_id, user_id, question_number, question_text, concept, key_points) values (${QA2}, ${SA}, ${A}, 2, 'What does a catalyst do?', 'Catalysts', '["lower barrier"]'::jsonb)`);
  await tx.execute(sql`
    insert into public.viva_answers (id, question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback)
    values (${AA}, ${QA}, ${SA}, ${A}, 'More energy, more collisions.', 8, 6, 8, 7, 73, 'Good start.')`);
}

describe.skipIf(!live)("viva tables (live DB, rolled back)", () => {
  it("RLS is on for all three viva tables, each with an own-row read policy", async () => {
    const r = rows<{ relname: string; relrowsecurity: boolean }>(
      await db.execute(sql`select relname, relrowsecurity from pg_class where relname in ('viva_sessions','viva_questions','viva_answers') and relnamespace = 'public'::regnamespace order by relname`),
    );
    expect(r).toEqual([
      { relname: "viva_answers", relrowsecurity: true },
      { relname: "viva_questions", relrowsecurity: true },
      { relname: "viva_sessions", relrowsecurity: true },
    ]);
    const policies = rows<{ policyname: string }>(await db.execute(sql`select policyname from pg_policies where tablename like 'viva_%' order by policyname`));
    expect(policies.map((p) => p.policyname)).toEqual(["viva_answers_select_own", "viva_questions_select_own", "viva_sessions_select_own"]);
  });

  it("a student reads only their own viva rows; anonymous visitors can read nothing", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await actAs(tx, A);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.viva_sessions`)).map((r) => r.id)).toEqual([SA]);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.viva_questions`)).map((r) => r.id).sort()).toEqual([QA, QA2]);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.viva_answers`)).map((r) => r.id)).toEqual([AA]);
      expect(rows(await tx.execute(sql`select id from public.viva_sessions where id = ${SB}`))).toHaveLength(0);
      await actAs(tx, B);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.viva_questions`)).map((r) => r.id)).toEqual([QB]);
      expect(rows(await tx.execute(sql`select id from public.viva_answers`))).toHaveLength(0);
      await actAs(tx, null);
      for (const t of ["viva_sessions", "viva_questions", "viva_answers"]) await expectRejected(tx, sql.raw(`select id from public.${t}`), DENIED);
    });
  });

  it("the examiner's key points cannot be read by a student, however they ask", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await actAs(tx, A);
      await expectRejected(tx, sql`select key_points from public.viva_questions`, DENIED);
      await expectRejected(tx, sql`select * from public.viva_questions`, DENIED);
      await expectRejected(tx, sql`select q.key_points from public.viva_questions q join public.viva_sessions s on s.id = q.session_id`, DENIED);
      await expectRejected(tx, sql`select to_jsonb(q) from public.viva_questions q`, DENIED);
      // The columns a student may read are still readable.
      expect(rows<{ question_text: string }>(await tx.execute(sql`select question_number, question_text, concept from public.viva_questions`))).toHaveLength(2);
    });
  });

  it("a student cannot create, change or delete viva data directly (it is all done by the server)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await actAs(tx, A);
      await expectRejected(tx, sql`update public.viva_sessions set status = 'completed', score = 100, completed_at = now() where id = ${SA}`, DENIED);
      await expectRejected(tx, sql`update public.viva_answers set score = 100, correctness = 10 where id = ${AA}`, DENIED);
      await expectRejected(tx, sql`delete from public.viva_answers where id = ${AA}`, DENIED);
      await expectRejected(tx, sql`delete from public.viva_sessions where id = ${SA}`, DENIED);
      await expectRejected(tx, sql`insert into public.viva_sessions (user_id, subject, difficulty, question_count) values (${A}, 'x', 'easy', 5)`, DENIED);
      await expectRejected(tx, sql`insert into public.viva_questions (session_id, user_id, question_number, question_text, concept, key_points) values (${SA}, ${A}, 2, 'q', 'c', '["k"]'::jsonb)`, DENIED);
    });
  });

  it("composite foreign keys make cross-student links impossible, even for the server", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      // B's question attached to A's session.
      await expectRejected(tx, sql`insert into public.viva_questions (session_id, user_id, question_number, question_text, concept, key_points) values (${SA}, ${B}, 3, 'q', 'c', '["k"]'::jsonb)`, /foreign key/i);
      // B's answer to A's question.
      await expectRejected(
        tx,
        sql`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values (${QA2}, ${SA}, ${B}, 'x', 1, 1, 1, 1, 10, 'f')`,
        /foreign key/i,
      );
      // An answer whose question belongs to a different viva.
      await expectRejected(
        tx,
        sql`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values (${QB}, ${SB}, ${A}, 'x', 1, 1, 1, 1, 10, 'f')`,
        /foreign key/i,
      );
      await expectRejected(
        tx,
        sql`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values (${QB}, ${SA}, ${A}, 'x', 1, 1, 1, 1, 10, 'f')`,
        /foreign key/i,
      );
    });
  });

  it("the database refuses malformed viva data (second line of defence behind the API)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const bad = (q: ReturnType<typeof sql>, re = CHECK) => expectRejected(tx, q, re);
      const session = (cols: string) => sql.raw(`insert into public.viva_sessions (user_id, subject, difficulty, question_count, status, score, completed_at) values ('${A}', ${cols})`);
      await bad(session(`'x', 'impossible', 5, 'in_progress', null, null`)); // unknown difficulty
      await bad(session(`'', 'easy', 5, 'in_progress', null, null`)); // empty subject
      await bad(session(`'x', 'easy', 2, 'in_progress', null, null`)); // too few questions
      await bad(session(`'x', 'easy', 16, 'in_progress', null, null`)); // too many questions
      await bad(session(`'x', 'easy', 5, 'finished', null, null`)); // unknown status
      await bad(session(`'x', 'easy', 5, 'completed', null, null`)); // completed without a score
      await bad(session(`'x', 'easy', 5, 'in_progress', 50, now()`)); // a score before it is completed
      await bad(session(`'x', 'easy', 5, 'completed', 150, now()`)); // score above 100
      await bad(sql`insert into public.viva_questions (session_id, user_id, question_number, question_text, concept, key_points) values (${SA}, ${A}, 3, 'q', 'c', '[]'::jsonb)`); // no key points
      await bad(sql`insert into public.viva_questions (session_id, user_id, question_number, question_text, concept, key_points) values (${SA}, ${A}, 16, 'q', 'c', '["k"]'::jsonb)`); // number out of range
      await bad(sql`insert into public.viva_questions (session_id, user_id, question_number, question_text, concept, key_points) values (${SA}, ${A}, 1, 'again', 'c', '["k"]'::jsonb)`, /duplicate key|unique/i); // same position twice
      const answer = (cols: string) =>
        sql.raw(`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values ('${QB}', '${SB}', '${B}', ${cols})`);
      await bad(answer(`'x', 11, 5, 5, 5, 50, 'f'`)); // a 0-10 score of 11
      await bad(answer(`'x', 5, 5, 5, -1, 50, 'f'`)); // negative
      await bad(answer(`'x', 5, 5, 5, 5, 101, 'f'`)); // score above 100
      await bad(answer(`'', 5, 5, 5, 5, 50, 'f'`)); // empty answer
      await bad(answer(`'x', 5, 5, 5, 5, 50, ''`)); // empty feedback
      await bad(sql`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values (${QA}, ${SA}, ${A}, 'second', 1, 1, 1, 1, 10, 'f')`, /duplicate key|unique/i); // one answer per question
    });
  });

  it("start -> answer -> next -> ... -> complete, with ownership enforced by the database (Mock provider, no real AI)", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = createVivaRepository(tx as unknown as Database);
      const service = createVivaService({ repo, ai: new MockProvider(0), topics: async () => [] });
      const started = await service.create(A, { subject: "Chemistry", topic: "Rates", difficulty: "easy", questionCount: 3 });
      expect(started.session).toMatchObject({ status: "in_progress", isMock: true, answeredCount: 0, score: null });
      expect(started.questions[0]).toMatchObject({ number: 1, keyPoints: null, answer: null });
      const id = started.session.id;

      await expect(service.detail(B, id)).rejects.toMatchObject({ status: 404 });
      await expect(service.answer(B, id, { questionId: started.questions[0]!.id, answer: "B tries" })).rejects.toMatchObject({ status: 404 });

      let d = started;
      for (let i = 1; i <= 3; i++) {
        d = await service.answer(A, id, { questionId: d.questions.at(-1)!.id, answer: "Core idea and key terms: the idea is about energy and terms of reactions." });
        expect(d.questions.at(-1)!.answer).not.toBeNull();
        expect(d.questions.at(-1)!.keyPoints).not.toBeNull();
        if (i < 3) d = await service.next(A, id);
      }
      expect(d.session).toMatchObject({ status: "completed", answeredCount: 3 });
      expect(d.session.score).toBe(d.result!.overall);
      expect(d.session.completedAt).not.toBeNull();
      await expect(service.answer(A, id, { questionId: d.questions[0]!.id, answer: "late" })).rejects.toMatchObject({ status: 409 });

      // Stored as one completed viva with three questions and three answers; the examiner's key points are in the table.
      await tx.execute(sql`reset role`);
      const stored = rows<{ q: number; a: number; kp: number }>(
        await tx.execute(sql`select (select count(*)::int from public.viva_questions where session_id = ${id}) as q, (select count(*)::int from public.viva_answers where session_id = ${id}) as a, (select count(*)::int from public.viva_questions where session_id = ${id} and jsonb_array_length(key_points) >= 1) as kp`),
      )[0]!;
      expect(stored).toEqual({ q: 3, a: 3, kp: 3 });

      // Practice again: a new viva; the old one is untouched.
      const again = await service.create(A, { subject: "Chemistry", topic: "Rates", difficulty: "easy", questionCount: 3 });
      expect(again.session.id).not.toBe(id);
      const list = await service.list(A);
      // (Inside this single test transaction both rows share one now(), so the newest-first order is not asserted here.)
      expect(list.sessions.map((s) => s.status).sort()).toEqual(["completed", "in_progress"]);
      expect(list.summary.completed).toBe(1);
      expect((await service.list(B)).sessions).toEqual([]);

      // Abandoning keeps everything.
      expect((await service.abandon(A, again.session.id)).session.status).toBe("abandoned");
      await expect(service.abandon(A, again.session.id)).rejects.toMatchObject({ status: 409 });
      expect((await service.detail(A, again.session.id)).questions).toHaveLength(1);
    });
  });
});
