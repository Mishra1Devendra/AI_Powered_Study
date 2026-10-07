import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { createSearchRepository } from "./repository.js";

/**
 * Live-database tests for global search (Phase 12). Everything runs inside ONE transaction that is ALWAYS rolled back: no
 * users, documents or plans are ever persisted and no real account is touched. This runs the REAL SQL (ILIKE, grouping,
 * limits) and Row Level Security that the in-memory tests can only imitate.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROLLBACK = new Error("rollback");

const live = !!process.env.DATABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hash = (c: string) => c.repeat(64).slice(0, 64);

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'search-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'search-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
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
  const doc = (n: number, user: string, title: string, h: string, status = "ready", deleted = false) =>
    tx.execute(sql`
      insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status, deleted_at)
      values (${id(n)}, ${user}, ${title}, ${`${title}.md`}, 'md', 'upload', 'text/markdown', 100, ${hash(h)}, ${`${user}/${id(n)}/original.md`}, ${status}, ${deleted ? sql`now()` : null})`);
  await doc(1, A, "Thermodynamics notes", "a");
  await doc(2, A, "Thermal engines (processing)", "b", "processing");
  await doc(3, A, "Thermo deleted", "c", "ready", true);
  await doc(4, B, "Thermochemistry secrets", "d");
  await tx.execute(sql`
    insert into public.quizzes (id, user_id, title, source_type, subject, topic, difficulty, question_count, question_types, status) values
      (${id(10)}, ${A}, 'Heat quiz', 'topic', 'Physics', 'Thermodynamics', 'easy', 1, array['mcq'], 'ready'),
      (${id(11)}, ${A}, 'Failed quiz', 'topic', 'Physics', 'Thermodynamics', 'easy', 1, array['mcq'], 'failed'),
      (${id(12)}, ${B}, 'Bob quiz', 'topic', 'Chemistry', 'Thermochemistry basics', 'easy', 1, array['mcq'], 'ready')`);
  await tx.execute(sql`
    insert into public.study_plans (id, user_id, title, exam_date, start_date, minutes_per_day, knowledge_level, study_days, subjects, status) values
      (${id(20)}, ${A}, 'Thermo boards', '2030-02-01', '2030-01-01', 60, 'beginner', array[1,2,3], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, 'active'),
      (${id(21)}, ${A}, 'Thermo draft', '2030-02-01', '2030-01-01', 60, 'beginner', array[1,2,3], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, 'generating'),
      (${id(22)}, ${B}, 'Bob thermo plan', '2030-02-01', '2030-01-01', 60, 'beginner', array[1,2,3], '[{"name":"Physics","priority":"high","topics":[]}]'::jsonb, 'active')`);
  await tx.execute(sql`
    insert into public.conversations (id, user_id, title, subject, topic) values
      (${id(30)}, ${A}, 'What is entropy?', 'Physics', 'Thermodynamics'),
      (${id(31)}, ${B}, 'Bob asks about thermo', null, null)`);
  // A notes (per-document) conversation must never show up as a tutor chat.
  await tx.execute(sql`insert into public.conversations (id, user_id, title, document_id) values (${id(32)}, ${A}, 'Notes: Thermodynamics notes', ${id(1)})`);
}

describe.skipIf(!live)("global search (live DB, rolled back)", () => {
  it("finds the student's own records, grouped, with in-app links", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await createSearchRepository(tx as unknown as Database).search(A, "thermo");
      expect(r.documents).toEqual([{ id: id(1), title: "Thermodynamics notes", detail: "Thermodynamics notes.md", href: `/notes/${id(1)}` }]);
      expect(r.quizzes).toEqual([{ id: id(10), title: "Heat quiz", detail: "Physics · Thermodynamics", href: `/quiz/${id(10)}` }]);
      expect(r.plans.map((p) => p.id)).toEqual([id(20)]);
      expect(r.plans[0]).toMatchObject({ detail: "Exam on 2030-02-01", href: `/study-plan/${id(20)}` });
      expect(r.conversations).toEqual([{ id: id(30), title: "What is entropy?", detail: "Physics · Thermodynamics", href: `/tutor/${id(30)}` }]);
      expect(r.topics).toEqual([{ subject: "Physics", topic: "Thermodynamics" }]);
    });
  });

  it("leaves out documents that are not ready or are deleted, quizzes that failed, plans still being made, and notes chats", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const r = await createSearchRepository(tx as unknown as Database).search(A, "thermo");
      const all = JSON.stringify(r);
      for (const hidden of ["processing", "deleted", "Failed quiz", "Thermo draft", "Notes: Thermodynamics notes"]) expect(all).not.toContain(hidden);
    });
  });

  it("never returns another student's records (application filter AND Row Level Security)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const repo = createSearchRepository(tx as unknown as Database);
      const b = await repo.search(B, "thermo");
      expect(b.documents.map((d) => d.id)).toEqual([id(4)]);
      expect(b.quizzes.map((d) => d.id)).toEqual([id(12)]);
      expect(b.plans.map((d) => d.id)).toEqual([id(22)]);
      expect(b.conversations.map((d) => d.id)).toEqual([id(31)]);
      expect(b.topics).toEqual([{ subject: "Chemistry", topic: "Thermochemistry basics" }]);
      expect(JSON.stringify(b)).not.toMatch(/Thermodynamics notes|Heat quiz|Thermo boards|entropy|Physics/);
      const a = await repo.search(A, "thermo");
      expect(JSON.stringify(a)).not.toMatch(/secrets|Bob|Chemistry/);
    });
  });

  it("a student with no records gets empty groups", async () => {
    await inRolledBackTx(async (tx) => {
      const r = await createSearchRepository(tx as unknown as Database).search(A, "anything");
      expect([r.documents, r.quizzes, r.plans, r.conversations, r.topics].every((g) => g.length === 0)).toBe(true);
    });
  });

  it("wildcards and quotes are matched literally and cannot inject SQL", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const repo = createSearchRepository(tx as unknown as Database);
      for (const q of ["%%", "__", "100%", "a_b", "'; drop table documents; --", "\\", "!!", "thermo' or '1'='1"]) {
        const r = await repo.search(A, q);
        expect(r.documents).toEqual([]); // none of these is a title; "%%" must not match everything
      }
      expect((await repo.search(A, "Thermodynamics notes")).documents).toHaveLength(1); // the table is still there
    });
  });

  it("limits every group to five and the topics to six", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      for (let i = 0; i < 8; i++) {
        await tx.execute(sql`
          insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status)
          values (${id(100 + i)}, ${A}, ${`Bulk thermo ${i}`}, 'b.md', 'md', 'upload', 'text/markdown', 1, ${hash(String(i))}, ${`${A}/${id(100 + i)}/original.md`}, 'ready')`);
        await tx.execute(sql`insert into public.conversations (user_id, title, subject, topic) values (${A}, ${`Chat ${i}`}, 'Bulk', ${`Thermo topic ${i}`})`);
      }
      const r = await createSearchRepository(tx as unknown as Database).search(A, "thermo");
      expect(r.documents).toHaveLength(5);
      expect(r.conversations.length).toBeLessThanOrEqual(5);
      expect(r.topics.length).toBeLessThanOrEqual(6);
    });
  });
});
