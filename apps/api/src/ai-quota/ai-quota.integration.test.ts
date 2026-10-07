import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";
import { createAiUsageRepository } from "./repository.js";
import { createAiQuota } from "./service.js";

/** The daily AI allowance against the real database (rolled back): atomic charge, limit, refund, per-day rows, no client access. */
const A = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5";
const B = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const ROLLBACK = new Error("rollback");
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

describe.skipIf(!live)("daily AI allowance (live DB, rolled back)", () => {
  it("charges atomically up to the limit, refuses beyond it, refunds, keeps one row per day and hides the table from students", async () => {
    await expect(
      db.transaction(async (tx) => {
        for (const id of [A, B]) {
          await tx.execute(sql`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`${id.slice(0, 4)}-ai@invalid.test`}, '{}'::jsonb, now(), now())`);
        }
        const udb = tx as unknown as Database;
        const repo = createAiUsageRepository(udb);
        const day = "2026-10-06";

        expect(await repo.used(A, day)).toBe(0);
        expect(await repo.tryCharge(A, day, 3, 10)).toBe(3);
        expect(await repo.tryCharge(A, day, 3, 10)).toBe(6);
        expect(await repo.tryCharge(A, day, 3, 10)).toBe(9);
        // 9 + 3 > 10: refused, nothing changed
        expect(await repo.tryCharge(A, day, 3, 10)).toBeNull();
        expect(await repo.used(A, day)).toBe(9);
        // exactly the limit is allowed
        expect(await repo.tryCharge(A, day, 1, 10)).toBe(10);
        expect(await repo.tryCharge(A, day, 1, 10)).toBeNull();

        // refund, and never below zero
        await repo.refund(A, day, 4);
        expect(await repo.used(A, day)).toBe(6);
        await repo.refund(A, day, 100);
        expect(await repo.used(A, day)).toBe(0);

        // a first charge bigger than the whole limit is refused and leaves no row
        expect(await repo.tryCharge(B, day, 5, 3)).toBeNull();
        const none = (await tx.execute(sql`select count(*)::int as n from public.ai_usage where user_id = ${B}`)) as unknown as Array<{ n: number }>;
        expect(none[0]!.n).toBe(0);

        // each day is its own row; each account its own counter
        expect(await repo.tryCharge(A, "2026-10-07", 2, 10)).toBe(2);
        expect(await repo.tryCharge(B, day, 2, 10)).toBe(2);
        const rows = (await tx.execute(sql`select count(*)::int as n from public.ai_usage where user_id = ${A}`)) as unknown as Array<{ n: number }>;
        expect(rows[0]!.n).toBe(2);

        // through the service: administrators leave no trace
        const quota = createAiQuota({ repo, dailyUnits: 4, now: () => new Date("2026-10-08T10:00:00Z") });
        expect(await quota.charge(A, "admin", "quiz")).toBeNull();
        expect(await repo.used(A, "2026-10-08")).toBe(0);
        const c = await quota.charge(A, "student", "quiz");
        expect(await quota.usage(A, "student")).toMatchObject({ used: 3, remaining: 1, limit: 4 });
        await quota.refund(c);
        expect((await quota.usage(A, "student")).used).toBe(0);

        // a student's own database login can neither read nor change the counter
        for (const statement of ["select * from public.ai_usage", "update public.ai_usage set units = 0", "delete from public.ai_usage"]) {
          await withUser(udb, A, async (stx) => {
            try {
              await stx.transaction(async (sp) => sp.execute(sql.raw(statement)));
              throw new Error(`student could run: ${statement}`);
            } catch (err) {
              const e = err as Error & { cause?: Error };
              expect(e.cause?.message ?? e.message).toMatch(/permission denied/i);
            }
          });
        }
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }, 120_000);
});
