import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";
import { documents } from "./documents.js";

/**
 * AI Quiz. Everything here is written by the API server only (generation, grading); students
 * can READ their own rows through RLS and nothing else (see migration 0008 for the GRANTs).
 *
 * ANSWER SECRECY: `quiz_questions.correct_answer`, `explanation` and `source_ref` are not
 * readable by the students' database role at all (column-level privileges), so even a direct
 * PostgREST call with a valid student token cannot see an answer. The API reads them with its
 * privileged connection, and only returns them for an attempt that has been submitted.
 */

/** A quiz a student generated (from their notes, or from a subject/topic they typed). */
export const quizzes = pgTable(
  "quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** "notes" (see quiz_sources) or "topic" (general knowledge about `subject` / `topic`, no document). */
    sourceType: text("source_type").notNull(),
    subject: text("subject"),
    topic: text("topic"),
    /** Optional "focus on" text used to pick relevant parts of the notes. */
    focus: text("focus"),
    difficulty: text("difficulty").notNull(),
    /** The number of questions requested; a ready quiz has exactly this many. */
    questionCount: integer("question_count").notNull(),
    questionTypes: text("question_types").array().notNull(),
    /** Optional timer for every attempt. null = untimed. */
    timeLimitMinutes: integer("time_limit_minutes"),
    status: text("status").notNull().default("generating"),
    generationError: text("generation_error"),
    /** Who wrote the questions, so mock output is never mistaken for a real model's. */
    provider: text("provider"),
    model: text("model"),
    isMock: boolean("is_mock").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("quizzes_id_user_id_key").on(t.id, t.userId),
    check("quizzes_title_len", sql`char_length(btrim(${t.title})) between 1 and 200`),
    check("quizzes_source_type_valid", sql`${t.sourceType} in ('notes', 'topic')`),
    check("quizzes_topic_source_has_subject", sql`${t.sourceType} <> 'topic' or ${t.subject} is not null`),
    check("quizzes_difficulty_valid", sql`${t.difficulty} in ('easy', 'medium', 'hard', 'mixed')`),
    check("quizzes_question_count_valid", sql`${t.questionCount} between 1 and 50`),
    check("quizzes_question_types_valid", sql`cardinality(${t.questionTypes}) >= 1 and ${t.questionTypes} <@ array['mcq', 'true_false', 'short_answer', 'numerical']`),
    check("quizzes_time_limit_valid", sql`${t.timeLimitMinutes} is null or ${t.timeLimitMinutes} between 1 and 180`),
    check("quizzes_status_valid", sql`${t.status} in ('generating', 'ready', 'failed')`),
    check("quizzes_error_len", sql`${t.generationError} is null or char_length(${t.generationError}) <= 500`),
    index("quizzes_user_recent_idx").on(t.userId, t.createdAt.desc()),
    pgPolicy("quizzes_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

/** Which notes a notes-quiz was made from. Only references: no document text is copied. */
export const quizSources = pgTable(
  "quiz_sources",
  {
    quizId: uuid("quiz_id").notNull(),
    documentId: uuid("document_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ name: "quiz_sources_pkey", columns: [t.quizId, t.documentId] }),
    foreignKey({ name: "quiz_sources_quiz_owner_fk", columns: [t.quizId, t.userId], foreignColumns: [quizzes.id, quizzes.userId] }).onDelete("cascade"),
    foreignKey({ name: "quiz_sources_document_owner_fk", columns: [t.documentId, t.userId], foreignColumns: [documents.id, documents.userId] }).onDelete("cascade"),
    index("quiz_sources_document_idx").on(t.documentId, t.userId),
    pgPolicy("quiz_sources_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

/** One question. Options and answers are positional (an index into `options`). */
export const quizQuestions = pgTable(
  "quiz_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    questionOrder: integer("question_order").notNull(),
    questionType: text("question_type").notNull(),
    questionText: text("question_text").notNull(),
    /** JSON array of strings for mcq / true_false; null for short_answer / numerical. */
    options: jsonb("options"),
    /** mcq / true_false: the index of the correct option (a JSON number). SECRET until submission. */
    correctAnswer: jsonb("correct_answer").notNull(),
    /** SECRET until submission. */
    explanation: text("explanation").notNull(),
    /** Only a topic the app could reliably determine; null otherwise (never invented). */
    topic: text("topic"),
    difficulty: text("difficulty").notNull(),
    /** { documentId, chunkIndex, page, heading } of the passage the question came from, when known. SECRET until submission. */
    sourceRef: jsonb("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("quiz_questions_id_quiz_key").on(t.id, t.quizId),
    unique("quiz_questions_order_key").on(t.quizId, t.questionOrder),
    foreignKey({ name: "quiz_questions_quiz_owner_fk", columns: [t.quizId, t.userId], foreignColumns: [quizzes.id, quizzes.userId] }).onDelete("cascade"),
    check("quiz_questions_type_valid", sql`${t.questionType} in ('mcq', 'true_false', 'short_answer', 'numerical')`),
    check("quiz_questions_order_valid", sql`${t.questionOrder} >= 0`),
    check("quiz_questions_text_len", sql`char_length(btrim(${t.questionText})) between 1 and 1000`),
    check("quiz_questions_explanation_len", sql`char_length(btrim(${t.explanation})) between 1 and 1500`),
    check("quiz_questions_difficulty_valid", sql`${t.difficulty} in ('easy', 'medium', 'hard')`),
    check("quiz_questions_topic_len", sql`${t.topic} is null or char_length(${t.topic}) between 1 and 100`),
    check(
      "quiz_questions_options_shape",
      sql`(${t.questionType} in ('mcq', 'true_false') and jsonb_typeof(${t.options}) = 'array' and jsonb_array_length(${t.options}) between 2 and 6) or (${t.questionType} in ('short_answer', 'numerical') and ${t.options} is null)`,
    ),
    check("quiz_questions_choice_answer_is_index", sql`${t.questionType} not in ('mcq', 'true_false') or jsonb_typeof(${t.correctAnswer}) = 'number'`),
    pgPolicy("quiz_questions_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

/** One go at a quiz. A retry is a NEW attempt; earlier attempts are never changed or removed. */
export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("in_progress"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** Server-decided deadline for a timed quiz. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** The order THIS attempt presents the questions in (a shuffle on retries). */
    questionOrder: uuid("question_order").array().notNull(),
    score: integer("score"),
    total: integer("total"),
    percentage: numeric("percentage", { precision: 5, scale: 2, mode: "number" }),
    timeTakenSeconds: integer("time_taken_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("quiz_attempts_id_user_key").on(t.id, t.userId),
    unique("quiz_attempts_id_quiz_key").on(t.id, t.quizId),
    foreignKey({ name: "quiz_attempts_quiz_owner_fk", columns: [t.quizId, t.userId], foreignColumns: [quizzes.id, quizzes.userId] }).onDelete("cascade"),
    check("quiz_attempts_status_valid", sql`${t.status} in ('in_progress', 'submitted', 'expired')`),
    check("quiz_attempts_submitted_consistent", sql`(${t.status} = 'in_progress') = (${t.submittedAt} is null)`),
    check("quiz_attempts_score_valid", sql`${t.score} is null or (${t.total} is not null and ${t.score} between 0 and ${t.total})`),
    check("quiz_attempts_percentage_valid", sql`${t.percentage} is null or ${t.percentage} between 0 and 100`),
    // At most one unfinished attempt per quiz and student: "Start" resumes it instead of piling up duplicates.
    uniqueIndex("quiz_attempts_one_open_key").on(t.quizId, t.userId).where(sql`${t.status} = 'in_progress'`),
    index("quiz_attempts_user_recent_idx").on(t.userId, t.startedAt.desc()),
    index("quiz_attempts_quiz_idx").on(t.quizId, t.userId),
    pgPolicy("quiz_attempts_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

/** The student's chosen option for one question of one attempt. `is_correct` is set at submission only. */
export const quizAnswers = pgTable(
  "quiz_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id").notNull(),
    quizId: uuid("quiz_id").notNull(),
    questionId: uuid("question_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    selectedAnswer: integer("selected_answer").notNull(),
    isCorrect: boolean("is_correct"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("quiz_answers_attempt_question_key").on(t.attemptId, t.questionId),
    // The attempt, the question and the student must all belong to the same quiz and the same student.
    foreignKey({ name: "quiz_answers_attempt_owner_fk", columns: [t.attemptId, t.userId], foreignColumns: [quizAttempts.id, quizAttempts.userId] }).onDelete("cascade"),
    foreignKey({ name: "quiz_answers_attempt_quiz_fk", columns: [t.attemptId, t.quizId], foreignColumns: [quizAttempts.id, quizAttempts.quizId] }).onDelete("cascade"),
    foreignKey({ name: "quiz_answers_question_quiz_fk", columns: [t.questionId, t.quizId], foreignColumns: [quizQuestions.id, quizQuestions.quizId] }).onDelete("cascade"),
    check("quiz_answers_selected_valid", sql`${t.selectedAnswer} between 0 and 9`),
    index("quiz_answers_user_idx").on(t.userId),
    index("quiz_answers_question_idx").on(t.questionId, t.quizId),
    pgPolicy("quiz_answers_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export type QuizRow = typeof quizzes.$inferSelect;
export type QuizQuestionRow = typeof quizQuestions.$inferSelect;
export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
export type QuizAnswerRow = typeof quizAnswers.$inferSelect;
