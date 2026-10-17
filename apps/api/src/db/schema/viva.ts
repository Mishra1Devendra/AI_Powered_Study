import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgPolicy, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "./auth.js";
import { documents } from "./documents.js";

/**
 * AI Viva (text). Like the quiz and planner tables, everything is written by the API server only (question
 * generation, evaluation, scoring); students can READ their own rows through RLS and nothing else
 * (see migration 0012 for the GRANTs).
 *
 * `viva_questions.key_points` (what a strong answer covers, written by the AI with the question) is not readable by
 * the students' database role at all (column-level privileges): the API only returns it once the question has been
 * answered, so the examiner never gives the answer away. Nothing is ever hard-deleted: a viva is completed or
 * abandoned, and "Practice again" creates a NEW session.
 */

export const vivaSessions = pgTable(
  "viva_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    topic: text("topic"),
    difficulty: text("difficulty").notNull(),
    questionCount: integer("question_count").notNull(),
    status: text("status").notNull().default("in_progress"),
    /** 0-100: the mean of the answer scores. Set once, when the viva completes. */
    score: numeric("score", { precision: 5, scale: 2, mode: "number" }),
    /**
     * Phase 11 - where the questions come from: 'general' (the AI's own knowledge), 'notes' (all of the student's ready
     * notes) or 'document' (one specific document, `document_id`). Defaults to 'general', so every existing viva is unchanged.
     */
    sourceType: text("source_type").notNull().default("general"),
    documentId: uuid("document_id"),
    /** Who wrote the questions and evaluations, so demo output is never mistaken for a real model's. */
    model: text("model"),
    /** true as soon as ANY step came from the offline demo provider. */
    isMock: boolean("is_mock").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("viva_sessions_id_user_id_key").on(t.id, t.userId),
    check("viva_sessions_subject_len", sql`char_length(btrim(${t.subject})) between 1 and 100`),
    check("viva_sessions_topic_len", sql`${t.topic} is null or char_length(btrim(${t.topic})) between 1 and 100`),
    check("viva_sessions_difficulty_valid", sql`${t.difficulty} in ('easy', 'medium', 'hard')`),
    check("viva_sessions_question_count_valid", sql`${t.questionCount} between 3 and 15`),
    check("viva_sessions_source_type_valid", sql`${t.sourceType} in ('general', 'notes', 'document')`),
    // A specific-document viva always names its document; the other kinds never do.
    check("viva_sessions_source_consistent", sql`(${t.sourceType} = 'document') = (${t.documentId} is not null)`),
    // The document must belong to the SAME student as the viva.
    foreignKey({ name: "viva_sessions_document_owner_fk", columns: [t.documentId, t.userId], foreignColumns: [documents.id, documents.userId] }),
    index("viva_sessions_document_idx").on(t.documentId, t.userId),
    check("viva_sessions_status_valid", sql`${t.status} in ('in_progress', 'completed', 'abandoned')`),
    check("viva_sessions_score_valid", sql`${t.score} is null or ${t.score} between 0 and 100`),
    // A completed viva always has its score and completion time; the other states never do.
    check("viva_sessions_completed_consistent", sql`(${t.status} = 'completed') = (${t.completedAt} is not null and ${t.score} is not null)`),
    index("viva_sessions_user_recent_idx").on(t.userId, t.createdAt.desc()),
    pgPolicy("viva_sessions_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export const vivaQuestions = pgTable(
  "viva_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    questionNumber: integer("question_number").notNull(),
    questionText: text("question_text").notNull(),
    /** A short label for the idea this question tests (used for strong/weak areas). */
    concept: text("concept").notNull(),
    /** SECRET until the question has been answered: what a strong answer covers. */
    keyPoints: jsonb("key_points").notNull(),
    isFollowUp: boolean("is_follow_up").notNull().default(false),
    /**
     * Phase 11: the passage this question was based on (document id/title, chunk index, real page and heading), or null for a
     * general question. Metadata only - it never contains the answer. Not readable by the students' database role.
     */
    sourceRef: jsonb("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("viva_questions_id_session_key").on(t.id, t.sessionId),
    // One question per position: the same question can never be stored twice (e.g. a double click on "Next").
    unique("viva_questions_number_key").on(t.sessionId, t.questionNumber),
    foreignKey({ name: "viva_questions_session_owner_fk", columns: [t.sessionId, t.userId], foreignColumns: [vivaSessions.id, vivaSessions.userId] }).onDelete("cascade"),
    check("viva_questions_number_valid", sql`${t.questionNumber} between 1 and 15`),
    check("viva_questions_text_len", sql`char_length(btrim(${t.questionText})) between 1 and 600`),
    check("viva_questions_concept_len", sql`char_length(btrim(${t.concept})) between 1 and 80`),
    check("viva_questions_key_points_valid", sql`jsonb_typeof(${t.keyPoints}) = 'array' and jsonb_array_length(${t.keyPoints}) between 1 and 6`),
    pgPolicy("viva_questions_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export const vivaAnswers = pgTable(
  "viva_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    answerText: text("answer_text").notNull(),
    // The AI's four scores, 0-10, validated by the API before they are stored.
    correctness: smallint("correctness").notNull(),
    completeness: smallint("completeness").notNull(),
    clarity: smallint("clarity").notNull(),
    confidence: smallint("confidence").notNull(),
    /** 0-100, calculated by the API from the four scores (see SCORE_WEIGHTS in the shared package). */
    score: numeric("score", { precision: 5, scale: 2, mode: "number" }).notNull(),
    feedback: text("feedback").notNull(),
    missingConcepts: jsonb("missing_concepts").notNull().default(sql`'[]'::jsonb`),
    shouldFollowUp: boolean("should_follow_up").notNull().default(false),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One answer per question: a duplicate submission is rejected by the database itself.
    unique("viva_answers_question_key").on(t.questionId),
    foreignKey({ name: "viva_answers_question_session_fk", columns: [t.questionId, t.sessionId], foreignColumns: [vivaQuestions.id, vivaQuestions.sessionId] }).onDelete("cascade"),
    foreignKey({ name: "viva_answers_session_owner_fk", columns: [t.sessionId, t.userId], foreignColumns: [vivaSessions.id, vivaSessions.userId] }).onDelete("cascade"),
    check("viva_answers_text_len", sql`char_length(btrim(${t.answerText})) between 1 and 3000`),
    check("viva_answers_scores_valid", sql`${t.correctness} between 0 and 10 and ${t.completeness} between 0 and 10 and ${t.clarity} between 0 and 10 and ${t.confidence} between 0 and 10`),
    check("viva_answers_score_valid", sql`${t.score} between 0 and 100`),
    check("viva_answers_feedback_len", sql`char_length(${t.feedback}) between 1 and 1500`),
    check("viva_answers_missing_valid", sql`jsonb_typeof(${t.missingConcepts}) = 'array' and jsonb_array_length(${t.missingConcepts}) <= 6`),
    index("viva_answers_session_idx").on(t.sessionId, t.userId),
    pgPolicy("viva_answers_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();
