import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";
import { studySessions } from "./planner.js";

/**
 * Study checks (5 multiple-choice questions a student must pass before a session can be marked complete). The questions
 * INCLUDE their answer key, so this table is server-only: RLS is on and no client role has any grant or policy (migration 0016).
 * The API sends questions without the key and reveals the key only after the answers are submitted.
 */
export const sessionChecks = pgTable(
  "session_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    status: text("status").notNull().default("generating"),
    /** [{ id, text, options[], correctIndex, explanation }] - with the answer key. */
    questions: jsonb("questions"),
    /** [{ questionId, choice }] as submitted. */
    answers: jsonb("answers"),
    score: integer("score"),
    error: text("error"),
    provider: text("provider"),
    model: text("model"),
    isMock: boolean("is_mock").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "session_checks_session_owner_fk", columns: [t.sessionId, t.userId], foreignColumns: [studySessions.id, studySessions.userId] }).onDelete("cascade"),
    check("session_checks_status_valid", sql`${t.status} in ('generating', 'ready', 'passed', 'failed', 'error')`),
    check("session_checks_score_range", sql`${t.score} is null or ${t.score} between 0 and 5`),
    index("session_checks_session_created_idx").on(t.sessionId, t.createdAt),
  ],
).enableRLS();

export type SessionCheckRow = typeof sessionChecks.$inferSelect;
