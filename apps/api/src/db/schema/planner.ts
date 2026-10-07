import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgPolicy, pgTable, text, time, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";

/**
 * AI Study Planner. Like the quiz tables, everything is written by the API server only (generation,
 * session actions); students can READ their own rows through RLS (see migration 0010's GRANTs).
 *
 * History is never destroyed: regenerating creates a NEW plan and archives the old one (it is kept),
 * and rescheduling a session marks the original "rescheduled" and links it to the new session.
 */

export const studyPlans = pgTable(
  "study_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** The exam day itself has no sessions. */
    examDate: date("exam_date", { mode: "string" }).notNull(),
    /** First day the plan schedules (the student's "today" when it was generated). */
    startDate: date("start_date", { mode: "string" }).notNull(),
    targetScore: integer("target_score"),
    minutesPerDay: integer("minutes_per_day").notNull(),
    knowledgeLevel: text("knowledge_level").notNull(),
    /** ISO weekdays 1 (Mon) - 7 (Sun). */
    studyDays: integer("study_days").array().notNull(),
    preferredTime: text("preferred_time").notNull().default("any"),
    /** [{ name, priority, topics[] }] exactly as the student entered them. */
    subjects: jsonb("subjects").notNull(),
    status: text("status").notNull().default("generating"),
    generationError: text("generation_error"),
    summary: text("summary"),
    /** Topic names that did not fit before the exam, shown to the student. */
    unscheduledTopics: jsonb("unscheduled_topics").notNull().default(sql`'[]'::jsonb`),
    /** Weak quiz topics (from real attempts) the plan gives extra revision. */
    weakTopics: jsonb("weak_topics").notNull().default(sql`'[]'::jsonb`),
    provider: text("provider"),
    model: text("model"),
    isMock: boolean("is_mock").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("study_plans_id_user_id_key").on(t.id, t.userId),
    check("study_plans_title_len", sql`char_length(btrim(${t.title})) between 1 and 100`),
    check("study_plans_dates_valid", sql`${t.examDate} > ${t.startDate} and ${t.examDate} <= ${t.startDate} + 366`),
    check("study_plans_target_valid", sql`${t.targetScore} is null or ${t.targetScore} between 0 and 100`),
    check("study_plans_minutes_valid", sql`${t.minutesPerDay} between 15 and 480`),
    check("study_plans_level_valid", sql`${t.knowledgeLevel} in ('beginner', 'intermediate', 'advanced')`),
    check("study_plans_days_valid", sql`cardinality(${t.studyDays}) between 1 and 7 and ${t.studyDays} <@ array[1, 2, 3, 4, 5, 6, 7]`),
    check("study_plans_time_valid", sql`${t.preferredTime} in ('morning', 'afternoon', 'evening', 'any')`),
    check("study_plans_subjects_valid", sql`jsonb_typeof(${t.subjects}) = 'array' and jsonb_array_length(${t.subjects}) between 1 and 8`),
    check("study_plans_status_valid", sql`${t.status} in ('generating', 'active', 'archived', 'failed')`),
    check("study_plans_error_len", sql`${t.generationError} is null or char_length(${t.generationError}) <= 500`),
    check("study_plans_summary_len", sql`${t.summary} is null or char_length(${t.summary}) <= 600`),
    // One active plan per student: generating a new one archives the old one in the same transaction.
    uniqueIndex("study_plans_one_active_key").on(t.userId).where(sql`${t.status} = 'active'`),
    index("study_plans_user_recent_idx").on(t.userId, t.createdAt.desc()),
    pgPolicy("study_plans_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export const studySessions = pgTable(
  "study_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    scheduledDate: date("scheduled_date", { mode: "string" }).notNull(),
    startTime: time("start_time"),
    durationMinutes: integer("duration_minutes").notNull(),
    subject: text("subject").notNull(),
    topic: text("topic").notNull(),
    activityType: text("activity_type").notNull(),
    priority: text("priority").notNull(),
    status: text("status").notNull().default("planned"),
    /** Kept for a later phase (student notes on a session); not used yet. */
    notes: text("notes"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** A rescheduled session points back to the original it replaces (the original is kept). */
    rescheduledFromId: uuid("rescheduled_from_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("study_sessions_id_user_id_key").on(t.id, t.userId),
    foreignKey({ name: "study_sessions_plan_owner_fk", columns: [t.planId, t.userId], foreignColumns: [studyPlans.id, studyPlans.userId] }).onDelete("cascade"),
    foreignKey({ name: "study_sessions_rescheduled_from_fk", columns: [t.rescheduledFromId, t.userId], foreignColumns: [t.id, t.userId] }),
    check("study_sessions_duration_valid", sql`${t.durationMinutes} between 5 and 240`),
    check("study_sessions_subject_len", sql`char_length(btrim(${t.subject})) between 1 and 60`),
    check("study_sessions_topic_len", sql`char_length(btrim(${t.topic})) between 1 and 120`),
    check("study_sessions_activity_valid", sql`${t.activityType} in ('learn', 'practice', 'quiz', 'revision', 'mock_test')`),
    check("study_sessions_priority_valid", sql`${t.priority} in ('high', 'medium', 'low')`),
    check("study_sessions_status_valid", sql`${t.status} in ('planned', 'in_progress', 'completed', 'skipped', 'missed', 'rescheduled')`),
    check("study_sessions_completed_consistent", sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    check("study_sessions_notes_len", sql`${t.notes} is null or char_length(${t.notes}) <= 2000`),
    index("study_sessions_plan_date_idx").on(t.planId, t.scheduledDate),
    index("study_sessions_user_date_idx").on(t.userId, t.scheduledDate),
    pgPolicy("study_sessions_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export type StudyPlanRow = typeof studyPlans.$inferSelect;
export type StudySessionRow = typeof studySessions.$inferSelect;
