import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { addDays } from "./dates.js";
import { createPlannerRepository } from "./repository.js";
import { createPlannerService } from "./service.js";

/**
 * Live-database tests for the study planner. Everything runs inside ONE transaction that is ALWAYS
 * rolled back: no users, plans or sessions are ever persisted and no real account is touched.
 * Two synthetic users are inserted into auth.users inside it.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PA = "a1000000-0000-4000-8000-00000000000a";
const PB = "a1000000-0000-4000-8000-00000000000b";
const SA = "a2000000-0000-4000-8000-00000000000a";
const SB = "a2000000-0000-4000-8000-00000000000b";
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
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'plan-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'plan-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      try {
        await fn(tx);
      } catch (err) {
        // Surface the database's own reason (Drizzle wraps it as `cause`).
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

/** Server-side (privileged) inserts, as the API does after resolving the student from their token. */
async function seedPlan(tx: Tx, userId: string, planId: string, sessionId: string, status = "active") {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`
    insert into public.study_plans (id, user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status)
    values (${planId}, ${userId}, 'Boards', '2030-02-01', '2030-01-01', 60, 'beginner', array[1,2,3], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, ${status})`);
  await tx.execute(sql`
    insert into public.study_sessions (id, plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority)
    values (${sessionId}, ${planId}, ${userId}, '2030-01-02', 30, 'Physics', 'Forces', 'learn', 'high')`);
}

describe("study planner database (live, rolled back)", () => {
  it("RLS is on for both planner tables, with own-row read policies", async () => {
    const r = rows<{ relname: string; relrowsecurity: boolean }>(
      await db.execute(sql`select relname, relrowsecurity from pg_class where relname in ('study_plans','study_sessions') and relnamespace = 'public'::regnamespace order by relname`),
    );
    expect(r).toEqual([
      { relname: "study_plans", relrowsecurity: true },
      { relname: "study_sessions", relrowsecurity: true },
    ]);
    const policies = rows<{ policyname: string }>(await db.execute(sql`select policyname from pg_policies where tablename in ('study_plans','study_sessions') order by policyname`));
    expect(policies.map((p) => p.policyname)).toEqual(["study_plans_select_own", "study_sessions_select_own"]);
  });

  it("students can only READ their own rows; anonymous visitors can do nothing", async () => {
    await inRolledBackTx(async (tx) => {
      await seedPlan(tx, A, PA, SA);
      await seedPlan(tx, B, PB, SB);
      await actAs(tx, A);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.study_plans`)).map((r) => r.id)).toEqual([PA]);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.study_sessions`)).map((r) => r.id)).toEqual([SA]);
      expect(rows(await tx.execute(sql`select id from public.study_plans where id = ${PB}`))).toHaveLength(0);
      await actAs(tx, null);
      await expectRejected(tx, sql`select id from public.study_plans`, DENIED);
      await expectRejected(tx, sql`select id from public.study_sessions`, DENIED);
    });
  });

  it("a student cannot create, change or delete planner data directly (all writes go through the API)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedPlan(tx, A, PA, SA);
      await actAs(tx, A);
      await expectRejected(tx, sql`update public.study_sessions set status = 'completed', completed_at = now() where id = ${SA}`, DENIED);
      await expectRejected(tx, sql`update public.study_plans set status = 'archived' where id = ${PA}`, DENIED);
      await expectRejected(tx, sql`delete from public.study_sessions where id = ${SA}`, DENIED);
      await expectRejected(tx, sql`delete from public.study_plans where id = ${PA}`, DENIED);
      await expectRejected(
        tx,
        sql`insert into public.study_plans (user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects) values (${A}, 'x', '2030-02-01', '2030-01-01', 60, 'beginner', array[1], '[]'::jsonb)`,
        DENIED,
      );
    });
  });

  it("composite foreign keys make cross-student links impossible, even for the server", async () => {
    await inRolledBackTx(async (tx) => {
      await seedPlan(tx, A, PA, SA);
      await seedPlan(tx, B, PB, SB);
      // B's session pointing at A's plan.
      await expectRejected(
        tx,
        sql`insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority) values (${PA}, ${B}, '2030-01-03', 30, 'Physics', 'X', 'learn', 'high')`,
        /foreign key/i,
      );
      // A session claiming to be rescheduled from another student's session.
      await expectRejected(
        tx,
        sql`insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, priority, rescheduled_from_id) values (${PA}, ${A}, '2030-01-03', 30, 'Physics', 'X', 'learn', 'high', ${SB})`,
        /foreign key/i,
      );
    });
  });

  it("the database refuses malformed planner data (second line of defence behind the API)", async () => {
    await inRolledBackTx(async (tx) => {
      await seedPlan(tx, A, PA, SA);
      const bad = (q: ReturnType<typeof sql>) => expectRejected(tx, q, /check constraint|violates|invalid input/i);
      const plan = (cols: string) => sql.raw(`insert into public.study_plans (user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects) values ('${A}', ${cols}, '[]'::jsonb)`);
      await bad(plan(`'x', '2030-01-01', '2030-01-01', 60, 'beginner', array[1]`)); // exam not after start
      await bad(plan(`'x', '2031-06-01', '2030-01-01', 60, 'beginner', array[1]`)); // more than a year
      await bad(plan(`'x', '2030-02-01', '2030-01-01', 5, 'beginner', array[1]`)); // too few minutes
      await bad(plan(`'x', '2030-02-01', '2030-01-01', 900, 'beginner', array[1]`)); // too many minutes
      await bad(plan(`'x', '2030-02-01', '2030-01-01', 60, 'genius', array[1]`)); // unknown level
      await bad(plan(`'', '2030-02-01', '2030-01-01', 60, 'beginner', array[1]`)); // empty title
      const session = (cols: string) => sql.raw(`insert into public.study_sessions (plan_id, user_id, scheduled_date, duration_minutes, subject, topic, activity_type, status, completed_at, priority) values ('${PA}', '${A}', ${cols}, 'high')`);
      await bad(session(`'2030-01-02', 0, 'Physics', 'X', 'learn', 'planned', null`)); // zero minutes
      await bad(session(`'2030-01-02', 500, 'Physics', 'X', 'learn', 'planned', null`)); // too long
      await bad(session(`'2030-01-02', 30, 'Physics', 'X', 'nap', 'planned', null`)); // unknown activity
      await bad(session(`'2030-01-02', 30, 'Physics', 'X', 'learn', 'done', null`)); // unknown status
      await bad(session(`'2030-01-02', 30, 'Physics', 'X', 'learn', 'completed', null`)); // completed without a time
      await bad(session(`'2030-01-02', 30, 'Physics', '', 'learn', 'planned', null`)); // empty topic
      // Only one active plan per student.
      await expectRejected(
        tx,
        sql`insert into public.study_plans (user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status) values (${A}, 'Second', '2030-02-01', '2030-01-01', 60, 'beginner', array[1], '[{"name":"Maths"}]'::jsonb, 'active')`,
        /duplicate key|unique/i,
      );
    });
  });

  it("generate -> sessions -> reschedule -> regenerate, with ownership enforced by the database", async () => {
    await inRolledBackTx(async (tx) => {
      const database = tx as unknown as Database;
      const repo = createPlannerRepository(database);
      const service = createPlannerService({ repo, ai: new MockProvider(0), quizTopics: async () => [] });
      const { today } = await service.options(A);
      const input = {
        title: "Integration plan",
        examDate: addDays(today, 21),
        targetScore: 80,
        minutesPerDay: 120,
        knowledgeLevel: "intermediate" as const,
        subjects: [{ name: "Physics", priority: "high" as const, topics: ["Forces"] }],
        studyDays: [1, 2, 3, 4, 5], // weekends stay free, so there is room to reschedule
        preferredTime: "morning" as const,
      };
      const created = await service.generate(A, input);
      await service.whenIdle();
      const d = await service.detail(A, created.id);
      expect(d.plan).toMatchObject({ status: "active", isMock: true });
      expect(d.sessions.length).toBeGreaterThan(0);
      expect(d.sessions[0]!.startTime).toBe("08:00");
      expect(d.sessions.every((s) => s.date >= today && s.date < input.examDate)).toBe(true);
      await expect(service.detail(B, created.id)).rejects.toMatchObject({ status: 404 });

      const first = d.sessions[0]!;
      await expect(service.sessionAction(B, first.id, "start", {})).rejects.toMatchObject({ status: 404 });
      await service.sessionAction(A, first.id, "start", {});
      const done = await service.sessionAction(A, first.id, "complete", {});
      expect(done.session.completedAt).not.toBeNull();

      const second = d.sessions[1]!;
      const moved = await service.sessionAction(A, second.id, "reschedule", {});
      expect(moved.session.status).toBe("rescheduled");
      expect(moved.created).toMatchObject({ rescheduledFromId: second.id, status: "planned" });
      expect(moved.created!.date < input.examDate).toBe(true);

      const again = await service.regenerate(A, created.id);
      await service.whenIdle();
      const list = await service.list(A);
      expect(list.activePlanId).toBe(again.id);
      const old = list.plans.find((p) => p.id === created.id)!;
      expect(old.status).toBe("archived");
      expect(old.stats.completed).toBe(1);
      expect((await service.detail(A, created.id)).sessions).toHaveLength(d.sessions.length + 1);
      expect((await service.list(B)).plans).toHaveLength(0);
    });
  });
});
