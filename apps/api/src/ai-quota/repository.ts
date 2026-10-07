import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

/** One counter per account per UTC day. Server-only (the table has no client grants). */
export interface AiUsageRepository {
  /**
   * Adds `units` to the day's counter ONLY IF the new total stays within `limit`, in one atomic statement (two requests at once
   * cannot both squeeze under the limit). Returns the new total, or null when it would exceed the limit (nothing is changed).
   */
  tryCharge(userId: string, day: string, units: number, limit: number): Promise<number | null>;
  /** Gives units back (an action that failed before it used the AI). Never goes below zero. */
  refund(userId: string, day: string, units: number): Promise<void>;
  used(userId: string, day: string): Promise<number>;
}

export function createAiUsageRepository(db: Database): AiUsageRepository {
  return {
    async tryCharge(userId, day, units, limit) {
      // A single action bigger than the whole allowance can never be paid for.
      if (units > limit) return null;
      const rows = (await db.execute(sql`
        insert into public.ai_usage (user_id, day, units)
        values (${userId}::uuid, ${day}::date, ${units}::int)
        on conflict (user_id, day) do update set units = public.ai_usage.units + ${units}::int
        where public.ai_usage.units + ${units}::int <= ${limit}::int
        returning units`)) as unknown as Array<{ units: number }>;
      return rows[0]?.units ?? null;
    },
    async refund(userId, day, units) {
      await db.execute(sql`update public.ai_usage set units = greatest(0, units - ${units}::int) where user_id = ${userId}::uuid and day = ${day}::date`);
    },
    async used(userId, day) {
      const rows = (await db.execute(sql`select units from public.ai_usage where user_id = ${userId}::uuid and day = ${day}::date`)) as unknown as Array<{ units: number }>;
      return rows[0]?.units ?? 0;
    },
  };
}

/** In-memory twin for tests (same rules as the SQL). */
export function createInMemoryAiUsageRepository() {
  const counters = new Map<string, number>();
  const key = (u: string, d: string) => `${u}|${d}`;
  const repo: AiUsageRepository = {
    async tryCharge(u, d, units, limit) {
      if (units > limit) return null;
      const next = (counters.get(key(u, d)) ?? 0) + units;
      if (next > limit) return null;
      counters.set(key(u, d), next);
      return next;
    },
    async refund(u, d, units) {
      if (counters.has(key(u, d))) counters.set(key(u, d), Math.max(0, counters.get(key(u, d))! - units));
    },
    async used(u, d) {
      return counters.get(key(u, d)) ?? 0;
    },
  };
  return { repo, counters };
}
