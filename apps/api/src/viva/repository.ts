import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { SourceMode, VivaDifficulty, VivaQuestionSource, VivaStatus } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { vivaAnswers, vivaQuestions, vivaSessions } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";

export interface SessionRecord {
  id: string;
  subject: string;
  topic: string | null;
  difficulty: VivaDifficulty;
  questionCount: number;
  status: VivaStatus;
  score: number | null;
  answeredCount: number;
  model: string | null;
  isMock: boolean;
  /** Phase 11: where the questions come from. */
  sourceType: SourceMode;
  documentId: string | null;
  documentTitle: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface AnswerRecord {
  answerText: string;
  correctness: number;
  completeness: number;
  clarity: number;
  confidence: number;
  score: number;
  feedback: string;
  missingConcepts: string[];
  shouldFollowUp: boolean;
  answeredAt: Date;
}

export interface QuestionRecord {
  id: string;
  number: number;
  text: string;
  concept: string;
  keyPoints: string[];
  isFollowUp: boolean;
  /** Phase 11: the passage this question was based on (metadata only), or null. */
  sourceRef: VivaQuestionSource | null;
  answer: AnswerRecord | null;
}

export interface NewQuestion {
  text: string;
  concept: string;
  keyPoints: string[];
  isFollowUp: boolean;
  sourceRef?: VivaQuestionSource | null;
}

export interface NewAnswer extends Omit<AnswerRecord, "answeredAt"> {}

export interface NewSession {
  userId: string;
  subject: string;
  topic: string | null;
  difficulty: VivaDifficulty;
  questionCount: number;
  model: string;
  isMock: boolean;
  sourceType: SourceMode;
  /** Only for sourceType "document". The composite foreign key proves it is the SAME student's document. */
  documentId: string | null;
  firstQuestion: NewQuestion;
}

/**
 * Persistence for the viva. Session and answer reads run through `withUser` (Row Level Security as the student).
 * Questions are read with the privileged connection - their secret key points are not readable by the student's
 * database role - but always filtered by the verified user id. Writes use the privileged connection, scoped the same
 * way; composite foreign keys make it impossible to attach a question or answer to someone else's viva. Nothing is
 * ever hard-deleted.
 */
export interface VivaRepository {
  /** Saves the session and its first question in ONE transaction. */
  createSession(input: NewSession): Promise<string>;
  getSession(userId: string, sessionId: string): Promise<SessionRecord | null>;
  listSessions(userId: string, limit: number): Promise<SessionRecord[]>;
  /** The viva's questions in order, each with its answer (if any). */
  listQuestions(userId: string, sessionId: string): Promise<QuestionRecord[]>;
  /** Adds the next question; returns null when that position is already taken (a duplicate request). */
  addQuestion(userId: string, sessionId: string, number: number, question: NewQuestion): Promise<QuestionRecord | null>;
  /**
   * Saves an answer and, when `complete` is given, completes the viva with its score - in ONE transaction.
   * "duplicate" = that question already has an answer; "conflict" = the viva is no longer in progress.
   */
  saveAnswer(userId: string, sessionId: string, questionId: string, answer: NewAnswer, complete: { score: number } | null): Promise<"saved" | "duplicate" | "conflict">;
  /** Marks the viva as using the offline demo provider (never flips back). */
  markMock(userId: string, sessionId: string): Promise<void>;
  /** in_progress -> abandoned. Returns false when it was not in progress. */
  abandon(userId: string, sessionId: string): Promise<boolean>;
}

const toSession = (r: typeof vivaSessions.$inferSelect & { answered: number; documentTitle: string | null }): SessionRecord => ({
  id: r.id,
  subject: r.subject,
  topic: r.topic,
  difficulty: r.difficulty as VivaDifficulty,
  questionCount: r.questionCount,
  status: r.status as VivaStatus,
  score: r.score,
  answeredCount: r.answered,
  model: r.model,
  isMock: r.isMock,
  sourceType: r.sourceType as SourceMode,
  documentId: r.documentId,
  documentTitle: r.documentTitle,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
});

const questionValues = (userId: string, sessionId: string, number: number, q: NewQuestion) => ({
  sessionId,
  userId,
  questionNumber: number,
  questionText: q.text,
  concept: q.concept,
  keyPoints: q.keyPoints,
  isFollowUp: q.isFollowUp,
  sourceRef: q.sourceRef ?? null,
});

export function createVivaRepository(db: Database): VivaRepository {
  // Written out by hand: Drizzle leaves table names off column references in a single-table select, which would make the inner "session_id = id" compare the wrong columns.
  const answered = sql<number>`(select count(*)::int from public.viva_answers va where va.session_id = public.viva_sessions.id)`.as("answered");

  const documentTitle = sql<string | null>`(select d.title from public.documents d where d.id = public.viva_sessions.document_id)`.as("document_title");

  const selectSessions = (tx: Pick<Database, "select">) => tx.select({ s: vivaSessions, answered, documentTitle }).from(vivaSessions);

  return {
    async createSession(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(vivaSessions)
          .values({ userId: input.userId, subject: input.subject, topic: input.topic, difficulty: input.difficulty, questionCount: input.questionCount, model: input.model, isMock: input.isMock, sourceType: input.sourceType, documentId: input.documentId })
          .returning({ id: vivaSessions.id });
        await tx.insert(vivaQuestions).values(questionValues(input.userId, row!.id, 1, input.firstQuestion));
        return row!.id;
      });
    },

    async getSession(userId, sessionId) {
      const rows = await withUser(db, userId, (tx) => selectSessions(tx).where(and(eq(vivaSessions.id, sessionId), eq(vivaSessions.userId, userId))).limit(1));
      return rows[0] ? toSession({ ...rows[0].s, answered: rows[0].answered, documentTitle: rows[0].documentTitle }) : null;
    },

    async listSessions(userId, limit) {
      const rows = await withUser(db, userId, (tx) => selectSessions(tx).where(eq(vivaSessions.userId, userId)).orderBy(desc(vivaSessions.createdAt)).limit(limit));
      return rows.map((r) => toSession({ ...r.s, answered: r.answered, documentTitle: r.documentTitle }));
    },

    async listQuestions(userId, sessionId) {
      const rows = await db
        .select({ q: vivaQuestions, a: vivaAnswers })
        .from(vivaQuestions)
        .leftJoin(vivaAnswers, eq(vivaAnswers.questionId, vivaQuestions.id))
        .where(and(eq(vivaQuestions.sessionId, sessionId), eq(vivaQuestions.userId, userId)))
        .orderBy(asc(vivaQuestions.questionNumber));
      return rows.map(({ q, a }) => ({
        id: q.id,
        number: q.questionNumber,
        text: q.questionText,
        concept: q.concept,
        keyPoints: q.keyPoints as string[],
        isFollowUp: q.isFollowUp,
        sourceRef: (q.sourceRef as VivaQuestionSource | null) ?? null,
        answer: a
          ? {
              answerText: a.answerText,
              correctness: a.correctness,
              completeness: a.completeness,
              clarity: a.clarity,
              confidence: a.confidence,
              score: a.score,
              feedback: a.feedback,
              missingConcepts: a.missingConcepts as string[],
              shouldFollowUp: a.shouldFollowUp,
              answeredAt: a.answeredAt,
            }
          : null,
      }));
    },

    async addQuestion(userId, sessionId, number, question) {
      const [row] = await db.insert(vivaQuestions).values(questionValues(userId, sessionId, number, question)).onConflictDoNothing().returning();
      return row ? { id: row.id, number: row.questionNumber, text: row.questionText, concept: row.concept, keyPoints: row.keyPoints as string[], isFollowUp: row.isFollowUp, sourceRef: (row.sourceRef as VivaQuestionSource | null) ?? null, answer: null } : null;
    },

    async saveAnswer(userId, sessionId, questionId, a, complete) {
      try {
        return await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(vivaAnswers)
            .values({
              questionId,
              sessionId,
              userId,
              answerText: a.answerText,
              correctness: a.correctness,
              completeness: a.completeness,
              clarity: a.clarity,
              confidence: a.confidence,
              score: a.score,
              feedback: a.feedback,
              missingConcepts: a.missingConcepts,
              shouldFollowUp: a.shouldFollowUp,
            })
            .onConflictDoNothing()
            .returning({ id: vivaAnswers.id });
          if (!inserted) return "duplicate" as const;
          if (complete) {
            const [done] = await tx
              .update(vivaSessions)
              .set({ status: "completed", score: complete.score, completedAt: new Date() })
              .where(and(eq(vivaSessions.id, sessionId), eq(vivaSessions.userId, userId), eq(vivaSessions.status, "in_progress")))
              .returning({ id: vivaSessions.id });
            if (!done) throw new NotInProgress();
          }
          return "saved" as const;
        });
      } catch (err) {
        if (err instanceof NotInProgress) return "conflict";
        throw err;
      }
    },

    async markMock(userId, sessionId) {
      await db.update(vivaSessions).set({ isMock: true }).where(and(eq(vivaSessions.id, sessionId), eq(vivaSessions.userId, userId)));
    },

    async abandon(userId, sessionId) {
      const rows = await db
        .update(vivaSessions)
        .set({ status: "abandoned" })
        .where(and(eq(vivaSessions.id, sessionId), eq(vivaSessions.userId, userId), eq(vivaSessions.status, "in_progress")))
        .returning({ id: vivaSessions.id });
      return rows.length > 0;
    },
  };
}

/** Rolls the answer back when the viva was abandoned while the examiner was evaluating. */
class NotInProgress extends Error {}
