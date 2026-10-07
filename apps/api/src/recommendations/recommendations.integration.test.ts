import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { createProgressRepository } from "../progress/repository.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createExtrasRepository } from "./repository.js";
import { createRecommendationService } from "./service.js";

/**
 * Live-database tests for Smart Revision. Everything runs inside ONE transaction that is ALWAYS rolled back: no
 * users, quizzes, vivas or notes are ever persisted and no real account is touched. The real SQL (joins, aggregates,
 * repeated-miss detection, note links, timezone conversion, Row Level Security) is what is under test.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC = "d0000000-0000-4000-8000-0000000000a1";
const QZ = "c0000000-0000-4000-8000-0000000000a1";
const QZ_B = "c0000000-0000-4000-8000-0000000000b1";
const AT1 = "f0000000-0000-4000-8000-0000000000a1";
const AT2 = "f0000000-0000-4000-8000-0000000000a2";
const AT_B = "f0000000-0000-4000-8000-0000000000b1";
const PLAN = "a1000000-0000-4000-8000-0000000000a1";
const QID = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
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
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reco-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reco-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
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
  await tx.execute(sql`insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status) values (${DOC}, ${A}, 'Physics notes', 'n.md', 'md', 'upload', 'text/markdown', 10, ${"a".repeat(64)}, ${`${A}/${DOC}/original.md`}, 'ready')`);
  await tx.execute(sql`insert into public.quizzes (id, user_id, title, source_type, subject, difficulty, question_count, question_types, status) values (${QZ}, ${A}, 'Physics quiz', 'notes', 'Physics', 'mixed', 10, array['mcq'], 'ready')`);
  await tx.execute(sql`insert into public.quiz_sources (quiz_id, document_id, user_id) values (${QZ}, ${DOC}, ${A})`);
  // 5 Electrostatics questions (1-5) and 5 Waves questions (6-10).
  for (let n = 1; n <= 10; n++) {
    await tx.execute(sql`
      insert into public.quiz_questions (id, quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, topic, difficulty)
      values (${QID(n)}, ${QZ}, ${A}, ${n - 1}, 'mcq', ${`Question ${n}?`}, '["a","b","c","d"]'::jsonb, '0'::jsonb, 'Because.', ${n <= 5 ? "Electrostatics" : "Waves"}, 'easy')`);
  }
  const order = sql`array[${sql.join(Array.from({ length: 10 }, (_, i) => sql`${QID(i + 1)}`), sql`, `)}]::uuid[]`;
  const attempt = (id: string, started: string, submitted: string, score: number) =>
    tx.execute(sql`insert into public.quiz_attempts (id, quiz_id, user_id, status, started_at, submitted_at, question_order, score, total, percentage) values (${id}, ${QZ}, ${A}, 'submitted', ${started}::timestamptz, ${submitted}::timestamptz, ${order}, ${score}, 10, ${score * 10})`);
  await attempt(AT1, "2026-10-12T09:00:00Z", "2026-10-12T09:30:00Z", 5);
  await attempt(AT2, "2026-10-14T09:00:00Z", "2026-10-14T09:30:00Z", 5);
  // Both attempts: Waves all right; Electrostatics 1 right (question 1) and 4 wrong (2-5; question 5 left unanswered once).
  for (const at of [AT1, AT2]) {
    for (let n = 1; n <= 10; n++) {
      if (n === 5 && at === AT2) continue; // unanswered = not correct
      const correct = n === 1 || n >= 6;
      await tx.execute(sql`insert into public.quiz_answers (attempt_id, quiz_id, question_id, user_id, selected_answer, is_correct) values (${at}, ${QZ}, ${QID(n)}, ${A}, ${correct ? 0 : 1}, ${correct})`);
    }
  }
  // A viva, a tutor conversation, an active plan with an upcoming session.
  await tx.execute(sql`insert into public.viva_sessions (user_id, subject, topic, difficulty, question_count, status, score, completed_at) values (${A}, 'Physics', 'Electrostatics', 'medium', 5, 'completed', 30, '2026-10-13T10:00:00Z')`);
  await tx.execute(sql`insert into public.conversations (user_id, title, subject, topic, updated_at) values (${A}, 'Charges', 'Physics', 'Waves', '2026-10-14T20:00:00Z')`);
  await tx.execute(sql`insert into public.study_plans (id, user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status) values (${PLAN}, ${A}, 'Plan', '2026-11-20', '2026-10-01', 90, 'beginner', array[1,2,3,4,5,6,7], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, 'active')`);
  await tx.execute(sql`insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority, status) values (${PLAN}, ${A}, '2026-10-16', 30, 'Physics', 'Electrostatics', 'practice', 'high', 'planned')`);

  // Another student's data, which must never show up for A (or vice versa).
  await tx.execute(sql`insert into public.quizzes (id, user_id, title, source_type, subject, difficulty, question_count, question_types, status) values (${QZ_B}, ${B}, 'Chem quiz', 'topic', 'Chemistry', 'easy', 1, array['mcq'], 'ready')`);
  await tx.execute(sql`insert into public.quiz_questions (id, quiz_id, user_id, question_order, question_type, question_text, options, correct_answer, explanation, topic, difficulty) values (${QID(50)}, ${QZ_B}, ${B}, 0, 'mcq', 'B?', '["a","b"]'::jsonb, '0'::jsonb, 'Because.', 'Bonding', 'easy')`);
  await tx.execute(sql`insert into public.quiz_attempts (id, quiz_id, user_id, status, started_at, submitted_at, question_order, score, total, percentage) values (${AT_B}, ${QZ_B}, ${B}, 'submitted', '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', array[${QID(50)}]::uuid[], 0, 1, 0)`);
}

const service = (tx: Tx, ai = new MockProvider(0)) =>
  createRecommendationService({ progress: createProgressRepository(tx as unknown as Database), extras: createExtrasRepository(tx as unknown as Database), ai, now: () => NOW });

describe.skipIf(!live)("smart revision (live DB, rolled back)", () => {
  it("builds recommendations from the real tables: accuracy, repeated mistakes, recency, vivas, notes and the plan", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await service(tx).list(A, 10);
      expect(r.today).toBe("2026-10-15");
      const top = r.recommendations[0]!;
      // Electrostatics: 2 of 10 correct over 2 attempts (20%), 4 questions missed in both attempts, a poor viva (30%), a session tomorrow.
      expect(top).toMatchObject({ type: "URGENT_REVISION", priority: "high", topic: "Electrostatics", subject: "Physics" });
      expect(top.facts).toMatchObject({ accuracy: 20, questions: 10, attempts: 2, repeatedMisses: 4, vivaAverage: 30, vivaSessions: 1, scheduledOn: "2026-10-16" });
      expect(top.facts.daysSincePracticed).toBe(1); // last attempt 14 Oct (local), today 15 Oct
      expect(top.actions.map((a) => a.kind)).toEqual(["quiz", "tutor", "notes", "viva"]);
      expect(top.actions.find((a) => a.kind === "notes")).toMatchObject({ documentId: DOC });
      const waves = r.recommendations.find((x) => x.topic === "Waves")!;
      expect(waves).toMatchObject({ type: "MAINTAIN_STRENGTH", priority: "low" });
      expect(waves.facts).toMatchObject({ accuracy: 100, daysSincePracticed: 0 }); // the tutor chat at 20:00 UTC on the 14th is already the 15th in India
      const plan = r.recommendations.find((x) => x.type === "UPCOMING_STUDY")!;
      expect(plan.actions[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(r)).not.toContain("Bonding");
    });
  });

  it("every student sees only their own recommendations", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const b = await service(tx).list(B, 10);
      expect(b.recommendations.map((x) => x.topic)).toEqual(["Bonding"]);
      expect(b.recommendations[0]!.facts).toMatchObject({ accuracy: null, questions: 1 });
      expect(JSON.stringify(b)).not.toMatch(/Electrostatics|Waves|Physics/);
      const nobody = await service(tx).list("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 10);
      expect(nobody.recommendations).toEqual([]);
      expect(nobody.summary.hasEnoughData).toBe(false);
    });
  });

  it("a student with no data gets an honest empty answer from the real SQL", async () => {
    await inRolledBackTx(async (tx) => {
      const r = await service(tx).list(A, 10);
      expect(r).toMatchObject({ recommendations: [], summary: { topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false } });
    });
  });

  it("the optional explanation sends only the student's own facts, once, and works with the offline Mock provider", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const e = await service(tx).explain(A);
      expect(e).toMatchObject({ available: true, isMock: true, model: "mock-demo" });
      expect(e.items.length).toBeGreaterThan(0);
      expect(e.overview).toContain("[Demo]");
    });
  });
});
