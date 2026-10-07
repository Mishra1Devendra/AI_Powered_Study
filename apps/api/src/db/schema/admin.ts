import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";

/**
 * Administration tables. Both are written and read ONLY by the API server (privileged connection) after it has proven the
 * requester - an admin for the audit log and the bug-report inbox, any signed-in account for filing a report. Row Level
 * Security is on and no client role has any grant or policy, so a browser talking to the database directly sees nothing.
 * (See migration 0015 for the REVOKEs.)
 */

/** Who did what, when. Append-only: the API never updates or deletes rows. `detail` holds ids/status words only, never content. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => authUsers.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetId: uuid("target_id"),
    detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt), check("audit_log_action_len", sql`char_length(${t.action}) between 1 and 60`)],
).enableRLS();

/** A bug report written by a student or an admin. The text is the person's own; nothing is attached automatically except the page path. */
export const bugReports = pgTable(
  "bug_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** The screen the person was on (a path such as /quiz), without any query string. */
    page: text("page"),
    /** "open" -> "in_progress" -> "resolved" (an admin moves a report across the Bug Tracker board). */
    status: text("status").notNull().default("open"),
    /** "bug", "feature" (a request) or "other". */
    type: text("type").notNull().default("bug"),
    /** "low", "medium" or "high" - as judged by the reporter. */
    severity: text("severity").notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
  },
  (t) => [
    index("bug_reports_created_idx").on(t.createdAt),
    index("bug_reports_user_created_idx").on(t.userId, t.createdAt),
    check("bug_reports_status_valid", sql`${t.status} in ('open', 'in_progress', 'resolved')`),
    check("bug_reports_type_valid", sql`${t.type} in ('bug', 'feature', 'other')`),
    check("bug_reports_severity_valid", sql`${t.severity} in ('low', 'medium', 'high')`),
    check("bug_reports_title_len", sql`char_length(btrim(${t.title})) between 3 and 120`),
    check("bug_reports_description_len", sql`char_length(btrim(${t.description})) between 10 and 2000`),
  ],
).enableRLS();

export type AuditLogRow = typeof auditLog.$inferSelect;
export type BugReportRow = typeof bugReports.$inferSelect;
