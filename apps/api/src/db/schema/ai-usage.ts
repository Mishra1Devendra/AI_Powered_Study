import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * How many AI "uses" each account has spent on each UTC day (migration 0019). Server-only: RLS is on and no client role has a
 * grant or a policy, so a student can neither read nor change their own counter. The API charges it atomically before an AI action.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    units: integer("units").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] }), check("ai_usage_units_nonnegative", sql`${t.units} >= 0`)],
).enableRLS();
