import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { createProgressRepository } from "./repository.js";
import { createProgressService } from "./service.js";

/**
 * Live-database tests for Progress & Analytics. Everything runs inside ONE transaction that is ALWAYS rolled
 * back: no users, plans, sessions or quizzes are ever persisted and no real account is touched.
 * The real SQL (joins, aggregates, timezone conversion, Row Level Security) is what is under test.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN_ACTIVE = "a1000000-0000-4000-8000-0000000000a1";
const PLAN_OLD = "a1000000-0000-4000-8000-0000000000a2";
const QUIZ = "c0000000-0000-4000-8000-0000000000a1";
const QUIZ_B = "c0000000-0000-4000-8000-0000000000b1";
const ATTEMPT = "f0000000-0000-4000-8000-0000000000a1";
const ATTEMPT_OPEN = "f0000000-0000-4000-8000-0000000000a2";
const ATTEMPT_B = "f0000000-0000-4000-8000-0000000000b1";
const Q = [1, 2, 3, 4].map((n) => `e0000000-0000-4000-8000-00000000000${n}`);
const QB = "e0000000-0000-4000-8000-0000000000b1";
const ROLLBACK = new Error("rollback");
/** 17:30 on 15 October in India (12:00 UTC). */
const NOW = new Date(Date.UTC(2026, 9, 15, 12));

const live = !!process.env.DATABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prog-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prog-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
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

async function seed(tx: Tx) {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`update public.student_profiles set timezone = 'Asia/Kolkata' where id = ${A}`);
  const plan = (id: string, status: string) =>
    tx.execute(sql`
      insert into public.study_plans (id, user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status)
      values (${id}, ${A}, 'Plan', '2026-12-01', '2026-10-01', 60, 'beginner', array[1,2,3,4,5], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, ${status})`);
  await plan(PLAN_OLD, "archived");
  await plan(PLAN_ACTIVE, "active");
  const session = (planId: string, date: string, status: string, completedAt: string | null, subject: string, activity: string, minutes: number) =>
    tx.execute(sql`
      insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority, status, completed_at)
      values (${planId}, ${A}, ${date}::date, ${minutes}, ${subject}, 'Topic', ${activity}, 'high', ${status}, ${completedAt}::timestamptz)`);
  // 20:00 UTC on the 14th is already the 15th in India; 10:00 UTC on the 14th is the 14th.
  await session(PLAN_ACTIVE, "2026-10-14", "completed", "2026-10-14T20:00:00Z", "Physics", "learn", 45);
  await session(PLAN_ACTIVE, "2026-10-14", "completed", "2026-10-14T10:00:00Z", "Physics", "practice", 30);
  await session(PLAN_ACTIVE, "2026-10-13", "skipped", null, "Maths", "learn", 30);
  await session(PLAN_ACTIVE, "2026-10-12", "planned", null, "Maths", "learn", 30); // day passed: missed
  await session(PLAN_ACTIVE, "2026-10-20", "planned", null, "Maths", "learn", 30); // upcoming
  await session(PLAN_ACTIVE, "2026-10-11", "rescheduled", null, "Maths", "learn", 30); // history only
  await session(PLAN_OLD, "2026-10-05", "planned", null, "Maths", "learn", 30); // replaced plan: not a miss
  await session(PLAN_OLD, "2026-10-04", "completed", "2026-10-04T08:00:00Z", "Physics", "revision", 60); // real study

  await tx.execute(sql`
    insert into public.quizzes (id, user_id, title, source_type, subject, difficulty, question_count, question_types, status)
    values (${QUIZ}, ${A}, 'Physics quiz', 'topic', 'Physics', 'mixed', 4, array['mcq'], 'ready')`);
  const topics = ["Heat", "Heat", "Heat", "Waves"];
  for (const [i, id] of Q.entries()) {
    await tx.execute(sql`
      insert into public.quiz_questions (id, quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, topic, difficulty)
      values (${id}, ${QUIZ}, ${A}, ${i}, 'mcq', ${`Question ${i}?`}, '["a","b","c","d"]'::jsonb, '0'::jsonb, 'Because.', ${topics[i]!}, ${i === 3 ? "hard" : "easy"})`);
  }
  const order = sql`array[${sql.join(Q.map((q) => sql`${q}`), sql`, `)}]::uuid[]`;
  await tx.execute(sql`
    insert into public.quiz_attempts (id, quiz_id, user_id, status, started_at, submitted_at, question_order, score, total, percentage)
    values (${ATTEMPT}, ${QUIZ}, ${A}, 'submitted', '2026-10-14T19:50:00Z', '2026-10-14T20:00:00Z', ${order}, 2, 4, 50)`);
  // An unfinished attempt must never count.
  await tx.execute(sql`
    insert into public.quiz_attempts (id, quiz_id, user_id, status, started_at, question_order)
    values (${ATTEMPT_OPEN}, ${QUIZ}, ${A}, 'in_progress', '2026-10-15T09:00:00Z', ${order})`);
  const answer = (q: string, correct: boolean) =>
    tx.execute(sql`
      insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer, is_correct)
      values (${ATTEMPT}, ${QUIZ}, ${q}, ${A}, ${correct ? 0 : 1}, ${correct})`);
  await answer(Q[0]!, true); // Heat, right
  await answer(Q[1]!, false); // Heat, wrong
  // Q[2] (Heat) left unanswered -> not correct
  await answer(Q[3]!, true); // Waves, right

  // Another student's data, which must never show up for A.
  await tx.execute(sql`
    insert into public.quizzes (id, user_id, title, source_type, subject, difficulty, question_count, question_types, status)
    values (${QUIZ_B}, ${B}, 'B quiz', 'topic', 'Chemistry', 'easy', 1, array['mcq'], 'ready')`);
  await tx.execute(sql`
    insert into public.quiz_questions (id, quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, topic, difficulty)
    values (${QB}, ${QUIZ_B}, ${B}, 0, 'mcq', 'B?', '["a","b"]'::jsonb, '0'::jsonb, 'Because.', 'Bonds', 'easy')`);
  await tx.execute(sql`
    insert into public.quiz_attempts (id, quiz_id, user_id, status, started_at, submitted_at, question_order, score, total, percentage)
    values (${ATTEMPT_B}, ${QUIZ_B}, ${B}, 'submitted', '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', array[${QB}]::uuid[], 1, 1, 100)`);
  await tx.execute(sql`
    insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer, is_correct)
    values (${ATTEMPT_B}, ${QUIZ_B}, ${QB}, ${B}, 0, true)`);
  await tx.execute(sql`
    insert into public.study_plans (id, user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status)
    values ('a1000000-0000-4000-8000-0000000000b1', ${B}, 'B plan', '2026-12-01', '2026-10-01', 60, 'beginner', array[1], '[{"name":"Chemistry","priority":"high","topics":[]}]'::jsonb, 'active')`);
  await tx.execute(sql`
    insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority, status, completed_at)
    values ('a1000000-0000-4000-8000-0000000000b1', ${B}, '2026-10-14', 120, 'Chemistry', 'Bonds', 'learn', 'high', 'completed', '2026-10-14T09:00:00Z')`);
}

const service = (tx: Tx) => createProgressService({ repo: createProgressRepository(tx as unknown as Database), now: () => NOW });

describe.skipIf(!live)("progress analytics (live DB, rolled back)", () => {
  it("calculates study time, completion and streaks from the real tables, in the student's timezone", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await service(tx).summary(A, "30d");
      expect(r.timezone).toBe("Asia/Kolkata");
      expect(r.today).toBe("2026-10-15");
      // Completed: 45 + 30 + 60 minutes (the 4 Oct session is still inside 30 days). One was finished late on the 14th UTC = the 15th in India.
      expect(r.studyTime).toMatchObject({ totalMinutes: 135, completedSessions: 3, skippedSessions: 1, missedSessions: 1, upcomingSessions: 1, activeDays: 3, granularity: "day" });
      expect(r.studyTime.completionRate).toBe(60); // 3 of (3 + 1 skipped + 1 missed); the replaced plan's session and the rescheduled original are not counted
      expect(r.studyTime.byPeriod.find((p) => p.start === "2026-10-15")).toMatchObject({ minutes: 45, sessions: 1 });
      expect(r.studyTime.byPeriod.find((p) => p.start === "2026-10-14")).toMatchObject({ minutes: 30, sessions: 1 });
      expect(r.studyTime.byActivity.map((a) => [a.activityType, a.minutes])).toEqual([["revision", 60], ["learn", 45], ["practice", 30]]);
      expect(r.streak).toMatchObject({ current: 2, longest: 2, studyDays: 3, lastStudyDate: "2026-10-15" }); // 4 Oct, 14 Oct, 15 Oct
      const week = await service(tx).summary(A, "7d");
      expect(week.studyTime).toMatchObject({ totalMinutes: 75, completedSessions: 2, previousMinutes: 60 });
      const all = await service(tx).summary(A, "all");
      expect(all.studyTime).toMatchObject({ totalMinutes: 135, completedSessions: 3, missedSessions: 1 });
    });
  });

  it("calculates quiz scores and topic accuracy: unanswered counts as not correct, unfinished attempts are ignored", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await service(tx).summary(A, "30d");
      expect(r.quiz).toMatchObject({ attemptsCompleted: 1, quizzesCompleted: 1, quizzesAttempted: 1, averageScore: 50, highestScore: 50, recentScore: 50, questions: 4, correct: 2, incorrect: 1, unanswered: 1, accuracy: 50 });
      expect(r.quiz.trend).toEqual([{ attemptId: ATTEMPT, date: "2026-10-15", percentage: 50, quizTitle: "Physics quiz" }]);
      expect(r.quiz.byDifficulty).toEqual([
        { difficulty: "easy", questions: 3, correct: 1, accuracy: null }, // too few questions for a percentage
        { difficulty: "hard", questions: 1, correct: 1, accuracy: null },
      ]);
      const heat = r.topics.find((t) => t.topic === "Heat")!;
      expect(heat).toMatchObject({ correct: 1, total: 3, accuracy: null, level: "insufficient", subject: "Physics" });
      expect(r.subjects.find((s) => s.subject === "Physics")).toMatchObject({ quizzes: 1, questions: 4, studyMinutes: 135, accuracy: null });
    });
  });

  it("recent activity is real and newest first", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await service(tx).summary(A, "7d");
      // A skipped session is dated by when it was last changed (here: the moment the test inserted it).
      expect(r.activity.map((e) => e.type).sort()).toEqual(["quiz_completed", "session_completed", "session_completed", "session_completed", "session_skipped"]);
      const done = r.activity.filter((e) => e.type !== "session_skipped");
      expect(done.map((e) => e.date)).toEqual(["2026-10-15", "2026-10-15", "2026-10-14", "2026-10-04"]); // newest first, in the student's own days
      expect(r.activity.find((e) => e.title === "Completed Physics — Topic" && e.detail === "45 min")).toMatchObject({ date: "2026-10-15" });
      expect(r.activity.find((e) => e.type === "quiz_completed")).toMatchObject({ detail: "50%", href: `/quiz/attempt/${ATTEMPT}/result` });
    });
  });

  it("every student sees only their own data", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const b = await service(tx).summary(B, "all");
      expect(b.studyTime).toMatchObject({ totalMinutes: 120, completedSessions: 1 });
      expect(b.studyTime.bySubject.map((s) => s.subject)).toEqual(["Chemistry"]);
      expect(b.quiz).toMatchObject({ attemptsCompleted: 1, averageScore: 100 });
      expect(b.topics.map((t) => t.topic)).toEqual(["Bonds"]);
      expect(JSON.stringify(b)).not.toContain("Physics");
      const a = await service(tx).summary(A, "all");
      expect(JSON.stringify(a)).not.toContain("Chemistry");
      const nobody = await service(tx).summary("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "all");
      expect(nobody.studyTime.totalMinutes).toBe(0);
      expect(nobody.quiz.attemptsCompleted).toBe(0);
    });
  });

  it("an answer cannot be counted twice: the database allows one answer per question and attempt", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await expect(
        tx.transaction(async (sp) =>
          sp.execute(sql`insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer, is_correct) values (${ATTEMPT}, ${QUIZ}, ${Q[0]!}, ${A}, 0, true)`),
        ),
      ).rejects.toThrow();
      const r = await service(tx).summary(A, "30d");
      expect(r.quiz.questions).toBe(4);
      expect(r.quiz.correct).toBe(2);
    });
  });

  it("the snapshot for the dashboard matches the full numbers", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const s = await service(tx).snapshot(A);
      expect(s).toMatchObject({ studyMinutes: 135, studiedToday: 45, averageScore: 50, attemptsCompleted: 1, currentStreak: 2, weakTopic: null });
    });
  });

  it("viva results come from the viva tables only: completed vivas count, abandoned ones do not, and quiz numbers are untouched", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const quizBefore = (await service(tx).summary(A, "30d")).quiz;
      await tx.execute(sql`reset role`);
      const V1 ="d1000000-0000-4000-8000-0000000000c1";
      const V2 = "d1000000-0000-4000-8000-0000000000c2";
      const VB = "d1000000-0000-4000-8000-0000000000c3";
      const viva = (id: string, user: string, status: string, score: number | null, completedAt: string | null, subject: string) =>
        tx.execute(sql`insert into public.viva_sessions (id, user_id, subject, topic, difficulty, question_count, status, score, completed_at)
          values (${id}, ${user}, ${subject}, 'Rates', 'medium', 3, ${status}, ${score}, ${completedAt}::timestamptz)`);
      // 20:00 UTC on the 14th is already the 15th in India.
      await viva(V1, A, "completed", 70, "2026-10-14T20:00:00Z", "Chemistry");
      await viva(V2, A, "abandoned", null, null, "Chemistry");
      await viva(VB, B, "completed", 95, "2026-10-14T10:00:00Z", "History");
      const answer = async (session: string, user: string, n: number, c: number, p: number, l: number, f: number) => {
        const q = `e1000000-0000-4000-8000-0000000000${n}${user === A ? "a" : "b"}`;
        await tx.execute(sql`insert into public.viva_questions (id, session_id, user_id, question_number, question_text, concept, key_points) values (${q}, ${session}, ${user}, ${n}, 'Why?', 'Rate', '["k"]'::jsonb)`);
        await tx.execute(sql`insert into public.viva_answers (question_id, session_id, user_id, answer_text, correctness, completeness, clarity, confidence, score, feedback) values (${q}, ${session}, ${user}, 'x', ${c}, ${p}, ${l}, ${f}, 50, 'f')`);
      };
      await answer(V1, A, 1, 8, 6, 8, 7);
      await answer(V1, A, 2, 6, 4, 6, 5);
      await answer(VB, B, 1, 10, 10, 10, 10);

      const a = await service(tx).summary(A, "30d");
      expect(a.viva).toMatchObject({ sessionsCompleted: 1, averageScore: 70, bestScore: 70, recentScore: 70 });
      expect(a.viva.dimensions).toEqual({ correctness: 70, completeness: 50, clarity: 70, confidence: 60 });
      expect(a.viva.recent).toEqual([{ id: V1, subject: "Chemistry", topic: "Rates", score: 70, date: "2026-10-15" }]);
      expect(a.quiz).toEqual(quizBefore);
      const b = await service(tx).summary(B, "all");
      expect(b.viva.bySubject).toEqual([{ subject: "History", sessions: 1, averageScore: 95 }]);
      expect((await service(tx).snapshot(A)).viva).toEqual({ lastScore: 70, subject: "Chemistry", topic: "Rates", completedCount: 1 });
      expect((await service(tx).summary(A, "7d")).viva.sessionsCompleted).toBe(1);
    });
  });

  it("a student with no data gets honest nulls from the real SQL too", async () => {
    await inRolledBackTx(async (tx) => {
      const r = await service(tx).summary(A, "all");
      expect(r.studyTime).toMatchObject({ totalMinutes: 0, completionRate: null, byPeriod: [] });
      expect(r.streak).toEqual({ current: null, longest: null, studyDays: 0, lastStudyDate: null });
      expect(r.quiz).toMatchObject({ attemptsCompleted: 0, averageScore: null, accuracy: null });
      expect(r.activity).toEqual([]);
    });
  });
});
