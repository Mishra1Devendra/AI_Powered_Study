import { and, asc, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type {
  AttemptHistoryItem,
  AttemptStatus,
  Difficulty,
  PlayQuestion,
  Quiz,
  QuizSourceType,
  QuizStatus,
  QuizSummary,
  QuestionDifficulty,
  QuestionType,
} from "@copilot/shared";
import type { Database } from "../db/client.js";
import { conversations, documents, quizAnswers, quizAttempts, quizQuestions, quizSources, quizzes } from "../db/schema/index.js";
import { withUser, type UserTx } from "../db/with-user.js";
import { roundPercent, topicPerformance } from "./grading.js";

export interface NewQuiz {
  userId: string;
  title: string;
  sourceType: QuizSourceType;
  subject: string | null;
  topic: string | null;
  focus: string | null;
  difficulty: Difficulty;
  questionCount: number;
  questionTypes: QuestionType[];
  timeLimitMinutes: number | null;
  documentIds: string[];
}

/** Where in the notes a question came from (stored only when the model's `source` key was real). */
export interface SourceRefStored {
  documentId: string;
  chunkIndex: number;
  page: number | null;
  heading: string | null;
  /** A verbatim quote from the notes that supports the answer, verified at generation time. */
  evidence?: string | null;
}

export interface NewQuestion {
  order: number;
  type: QuestionType;
  text: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  topic: string | null;
  difficulty: QuestionDifficulty;
  sourceRef: SourceRefStored | null;
}

/** A question INCLUDING its answer key. Never sent to the browser while an attempt is open. */
export interface StoredQuestion extends NewQuestion {
  id: string;
  quizId: string;
}

export interface AttemptRecord {
  id: string;
  quizId: string;
  status: AttemptStatus;
  startedAt: Date;
  expiresAt: Date | null;
  submittedAt: Date | null;
  questionOrder: string[];
  score: number | null;
  total: number | null;
  percentage: number | null;
  timeTakenSeconds: number | null;
}

export interface FinalizeData {
  status: "submitted" | "expired";
  submittedAt: Date;
  score: number;
  total: number;
  percentage: number;
  timeTakenSeconds: number;
  /** One entry per ANSWERED question. */
  graded: { questionId: string; isCorrect: boolean }[];
}

export interface GenerationMeta {
  provider: string;
  model: string;
  isMock: boolean;
}

/**
 * Persistence for AI Quiz. Reads run through `withUser` (Row Level Security as the student, and the
 * student's role cannot read the answer key). Writes - generation, saving answers, grading - and
 * the answer-key reads use the privileged connection, always scoped by the verified `userId`; the
 * composite foreign keys make it impossible to attach rows to another student's quiz.
 */
export interface QuizRepository {
  createQuiz(input: NewQuiz): Promise<Quiz>;
  findGenerating(userId: string): Promise<Quiz | null>;
  /**
   * Marks quizzes stuck in "generating" since before `olderThan` as failed (e.g. the server restarted),
   * except those this process is still working on (`keepIds`).
   */
  failStaleGenerating(userId: string, olderThan: Date, keepIds: string[]): Promise<number>;
  /** Stores the questions and marks the quiz ready in ONE transaction. False if it was no longer "generating". */
  completeGeneration(userId: string, quizId: string, questions: NewQuestion[], meta: GenerationMeta): Promise<boolean>;
  failGeneration(userId: string, quizId: string, error: string, meta?: GenerationMeta): Promise<void>;
  getQuiz(userId: string, quizId: string): Promise<Quiz | null>;
  listQuizzes(userId: string, limit: number): Promise<Quiz[]>;
  /** Questions as the player sees them (no answers). */
  listPlayQuestions(userId: string, quizId: string): Promise<PlayQuestion[]>;
  getFullQuestions(userId: string, quizId: string): Promise<StoredQuestion[]>;
  /** Plain config of a quiz, used to regenerate it. */
  getQuizConfig(userId: string, quizId: string): Promise<(NewQuiz & { id: string }) | null>;

  createAttempt(userId: string, quizId: string, questionOrder: string[], expiresAt: Date | null): Promise<AttemptRecord>;
  findOpenAttempt(userId: string, quizId: string): Promise<AttemptRecord | null>;
  getAttempt(userId: string, attemptId: string): Promise<AttemptRecord | null>;
  listAttemptsForQuiz(userId: string, quizId: string): Promise<AttemptRecord[]>;
  /** Upserts choices (`selected: null` clears one). Only while the attempt is still in progress. Returns false if it is not. */
  saveAnswers(userId: string, attemptId: string, answers: { questionId: string; selected: number | null }[], at: Date): Promise<boolean>;
  getAnswers(userId: string, attemptId: string): Promise<Map<string, number>>;
  /** Grades and closes the attempt. Returns false (and changes nothing) if it was not in progress. */
  finalizeAttempt(userId: string, attemptId: string, data: FinalizeData): Promise<boolean>;
  listAttemptHistory(userId: string, limit: number): Promise<AttemptHistoryItem[]>;
  summary(userId: string): Promise<QuizSummary>;
  topicSuggestions(userId: string, limit: number): Promise<{ subject: string; topic: string | null }[]>;
}

type QuizRow = typeof quizzes.$inferSelect;
type AttemptRow = typeof quizAttempts.$inferSelect;

const toAttempt = (r: AttemptRow): AttemptRecord => ({
  id: r.id,
  quizId: r.quizId,
  status: r.status as AttemptStatus,
  startedAt: r.startedAt,
  expiresAt: r.expiresAt,
  submittedAt: r.submittedAt,
  questionOrder: r.questionOrder,
  score: r.score,
  total: r.total,
  percentage: r.percentage,
  timeTakenSeconds: r.timeTakenSeconds,
});

export function sourceLabel(sourceType: QuizSourceType, subject: string | null, topic: string | null, titles: string[]): string {
  if (sourceType === "topic") return [subject, topic].filter(Boolean).join(" · ") || "General knowledge";
  if (titles.length === 0) return "Notes";
  return titles.length <= 2 ? titles.join(", ") : `${titles[0]}, ${titles[1]} +${titles.length - 2} more`;
}

export function createQuizRepository(db: Database): QuizRepository {
  /** Adds attempt statistics and source notes to quiz rows (one query each, not one per quiz). */
  async function hydrate(tx: UserTx, rows: QuizRow[]): Promise<Quiz[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [sources, stats, open] = await Promise.all([
      tx
        .select({ quizId: quizSources.quizId, id: documents.id, title: documents.title })
        .from(quizSources)
        .innerJoin(documents, and(eq(documents.id, quizSources.documentId), eq(documents.userId, quizSources.userId)))
        .where(inArray(quizSources.quizId, ids)),
      tx
        .select({
          quizId: quizAttempts.quizId,
          count: sql<number>`count(*)::int`,
          best: sql<number | null>`max(${quizAttempts.percentage})::float8`,
          last: sql<Date | null>`max(${quizAttempts.submittedAt})`,
        })
        .from(quizAttempts)
        .where(and(inArray(quizAttempts.quizId, ids), inArray(quizAttempts.status, ["submitted", "expired"])))
        .groupBy(quizAttempts.quizId),
      tx
        .select({ quizId: quizAttempts.quizId, id: quizAttempts.id })
        .from(quizAttempts)
        .where(and(inArray(quizAttempts.quizId, ids), eq(quizAttempts.status, "in_progress"))),
    ]);
    return rows.map((r) => {
      const docs = sources.filter((s) => s.quizId === r.id).map((s) => ({ id: s.id, title: s.title }));
      const st = stats.find((s) => s.quizId === r.id);
      return {
        id: r.id,
        title: r.title,
        sourceType: r.sourceType as QuizSourceType,
        sourceLabel: sourceLabel(r.sourceType as QuizSourceType, r.subject, r.topic, docs.map((d) => d.title)),
        subject: r.subject,
        topic: r.topic,
        sources: docs,
        difficulty: r.difficulty as Difficulty,
        questionCount: r.questionCount,
        questionTypes: r.questionTypes as QuestionType[],
        timeLimitMinutes: r.timeLimitMinutes,
        status: r.status as QuizStatus,
        error: r.generationError,
        isMock: r.isMock,
        model: r.model,
        createdAt: r.createdAt.toISOString(),
        attemptCount: st?.count ?? 0,
        bestPercentage: st?.best ?? null,
        lastAttemptAt: st?.last ? new Date(st.last).toISOString() : null,
        inProgressAttemptId: open.find((o) => o.quizId === r.id)?.id ?? null,
      };
    });
  }

  const one = async (userId: string, quizId: string): Promise<Quiz | null> =>
    withUser(db, userId, async (tx) => {
      const [row] = await tx.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId))).limit(1);
      return row ? ((await hydrate(tx, [row]))[0] ?? null) : null;
    });

  return {
    async createQuiz(input) {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(quizzes)
          .values({
            userId: input.userId,
            title: input.title,
            sourceType: input.sourceType,
            subject: input.subject,
            topic: input.topic,
            focus: input.focus,
            difficulty: input.difficulty,
            questionCount: input.questionCount,
            questionTypes: input.questionTypes,
            timeLimitMinutes: input.timeLimitMinutes,
          })
          .returning({ id: quizzes.id });
        if (input.documentIds.length > 0) {
          await tx.insert(quizSources).values(input.documentIds.map((documentId) => ({ quizId: row!.id, documentId, userId: input.userId })));
        }
        return row!.id;
      });
      return (await one(input.userId, id))!;
    },

    async findGenerating(userId) {
      const [row] = await db
        .select({ id: quizzes.id })
        .from(quizzes)
        .where(and(eq(quizzes.userId, userId), eq(quizzes.status, "generating")))
        .orderBy(desc(quizzes.createdAt))
        .limit(1);
      return row ? one(userId, row.id) : null;
    },

    async failStaleGenerating(userId, olderThan, keepIds) {
      const rows = await db
        .update(quizzes)
        .set({ status: "failed", generationError: "Quiz generation was interrupted. Please try again." })
        .where(
          and(
            eq(quizzes.userId, userId),
            eq(quizzes.status, "generating"),
            lt(quizzes.updatedAt, olderThan),
            ...(keepIds.length > 0 ? [notInArray(quizzes.id, keepIds)] : []),
          ),
        )
        .returning({ id: quizzes.id });
      return rows.length;
    },

    async completeGeneration(userId, quizId, questions, meta) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ status: quizzes.status })
          .from(quizzes)
          .where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId)))
          .for("update");
        if (!locked || locked.status !== "generating") return false;
        await tx.insert(quizQuestions).values(
          questions.map((q) => ({
            quizId,
            userId,
            questionOrder: q.order,
            questionType: q.type,
            questionText: q.text,
            options: q.options,
            correctAnswer: q.correctIndex,
            explanation: q.explanation,
            topic: q.topic,
            difficulty: q.difficulty,
            sourceRef: q.sourceRef,
          })),
        );
        await tx
          .update(quizzes)
          .set({ status: "ready", generationError: null, provider: meta.provider, model: meta.model, isMock: meta.isMock })
          .where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId)));
        return true;
      });
    },

    async failGeneration(userId, quizId, error, meta) {
      await db
        .update(quizzes)
        .set({ status: "failed", generationError: error.slice(0, 500), ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}) })
        .where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId), eq(quizzes.status, "generating")));
    },

    getQuiz: one,

    async listQuizzes(userId, limit) {
      return withUser(db, userId, async (tx) => {
        const rows = await tx.select().from(quizzes).where(eq(quizzes.userId, userId)).orderBy(desc(quizzes.createdAt)).limit(limit);
        return hydrate(tx, rows);
      });
    },

    async listPlayQuestions(userId, quizId) {
      // Column list matches the student role's column-level SELECT grant: no answer key columns.
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({
            id: quizQuestions.id,
            order: quizQuestions.questionOrder,
            type: quizQuestions.questionType,
            text: quizQuestions.questionText,
            options: quizQuestions.options,
            difficulty: quizQuestions.difficulty,
            topic: quizQuestions.topic,
          })
          .from(quizQuestions)
          .where(and(eq(quizQuestions.quizId, quizId), eq(quizQuestions.userId, userId)))
          .orderBy(asc(quizQuestions.questionOrder)),
      );
      return rows.map((r) => ({
        id: r.id,
        order: r.order,
        type: r.type as QuestionType,
        text: r.text,
        options: (r.options as string[] | null) ?? [],
        difficulty: r.difficulty as QuestionDifficulty,
        topic: r.topic,
      }));
    },

    async getFullQuestions(userId, quizId) {
      const rows = await db
        .select()
        .from(quizQuestions)
        .where(and(eq(quizQuestions.quizId, quizId), eq(quizQuestions.userId, userId)))
        .orderBy(asc(quizQuestions.questionOrder));
      return rows.map((r) => ({
        id: r.id,
        quizId: r.quizId,
        order: r.questionOrder,
        type: r.questionType as QuestionType,
        text: r.questionText,
        options: (r.options as string[] | null) ?? [],
        correctIndex: r.correctAnswer as number,
        explanation: r.explanation,
        topic: r.topic,
        difficulty: r.difficulty as QuestionDifficulty,
        sourceRef: (r.sourceRef as SourceRefStored | null) ?? null,
      }));
    },

    async getQuizConfig(userId, quizId) {
      const [row] = await db.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId))).limit(1);
      if (!row) return null;
      const docs = await db.select({ documentId: quizSources.documentId }).from(quizSources).where(and(eq(quizSources.quizId, quizId), eq(quizSources.userId, userId)));
      return {
        id: row.id,
        userId: row.userId,
        title: row.title,
        sourceType: row.sourceType as QuizSourceType,
        subject: row.subject,
        topic: row.topic,
        focus: row.focus,
        difficulty: row.difficulty as Difficulty,
        questionCount: row.questionCount,
        questionTypes: row.questionTypes as QuestionType[],
        timeLimitMinutes: row.timeLimitMinutes,
        documentIds: docs.map((d) => d.documentId),
      };
    },

    async createAttempt(userId, quizId, questionOrder, expiresAt) {
      const [row] = await db.insert(quizAttempts).values({ quizId, userId, questionOrder, expiresAt }).returning();
      return toAttempt(row!);
    },

    async findOpenAttempt(userId, quizId) {
      const [row] = await db
        .select()
        .from(quizAttempts)
        .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")))
        .limit(1);
      return row ? toAttempt(row) : null;
    },

    async getAttempt(userId, attemptId) {
      const [row] = await withUser(db, userId, (tx) =>
        tx.select().from(quizAttempts).where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.userId, userId))).limit(1),
      );
      return row ? toAttempt(row) : null;
    },

    async listAttemptsForQuiz(userId, quizId) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(quizAttempts)
          .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.userId, userId)))
          .orderBy(desc(quizAttempts.startedAt)),
      );
      return rows.map(toAttempt);
    },

    async saveAnswers(userId, attemptId, answers, at) {
      return db.transaction(async (tx) => {
        const [attempt] = await tx
          .select({ quizId: quizAttempts.quizId, status: quizAttempts.status })
          .from(quizAttempts)
          .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.userId, userId)))
          .for("update");
        if (!attempt || attempt.status !== "in_progress") return false;
        for (const a of answers) {
          if (a.selected === null) {
            await tx.delete(quizAnswers).where(and(eq(quizAnswers.attemptId, attemptId), eq(quizAnswers.questionId, a.questionId), eq(quizAnswers.userId, userId)));
          } else {
            await tx
              .insert(quizAnswers)
              .values({ attemptId, quizId: attempt.quizId, questionId: a.questionId, userId, selectedAnswer: a.selected, answeredAt: at })
              .onConflictDoUpdate({ target: [quizAnswers.attemptId, quizAnswers.questionId], set: { selectedAnswer: a.selected, answeredAt: at } });
          }
        }
        return true;
      });
    },

    async getAnswers(userId, attemptId) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({ questionId: quizAnswers.questionId, selected: quizAnswers.selectedAnswer })
          .from(quizAnswers)
          .where(and(eq(quizAnswers.attemptId, attemptId), eq(quizAnswers.userId, userId))),
      );
      return new Map(rows.map((r) => [r.questionId, r.selected]));
    },

    async finalizeAttempt(userId, attemptId, data) {
      return db.transaction(async (tx) => {
        const closed = await tx
          .update(quizAttempts)
          .set({
            status: data.status,
            submittedAt: data.submittedAt,
            score: data.score,
            total: data.total,
            percentage: data.percentage,
            timeTakenSeconds: data.timeTakenSeconds,
          })
          .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.userId, userId), eq(quizAttempts.status, "in_progress")))
          .returning({ id: quizAttempts.id });
        if (closed.length === 0) return false; // already submitted: nothing is changed or re-graded
        for (const g of data.graded) {
          await tx
            .update(quizAnswers)
            .set({ isCorrect: g.isCorrect })
            .where(and(eq(quizAnswers.attemptId, attemptId), eq(quizAnswers.questionId, g.questionId), eq(quizAnswers.userId, userId)));
        }
        return true;
      });
    },

    async listAttemptHistory(userId, limit) {
      const rows = await withUser(db, userId, async (tx) => {
        const attempts = await tx
          .select()
          .from(quizAttempts)
          .where(eq(quizAttempts.userId, userId))
          .orderBy(desc(quizAttempts.startedAt))
          .limit(limit);
        if (attempts.length === 0) return [];
        const quizRows = await tx.select().from(quizzes).where(inArray(quizzes.id, [...new Set(attempts.map((a) => a.quizId))]));
        const hydrated = await hydrate(tx, quizRows);
        return attempts.map((a) => ({ a, quiz: hydrated.find((q) => q.id === a.quizId)! }));
      });
      return rows
        .filter((r) => r.quiz)
        .map(({ a, quiz }) => ({
          id: a.id,
          quizId: a.quizId,
          quizTitle: quiz.title,
          sourceType: quiz.sourceType,
          sourceLabel: quiz.sourceLabel,
          difficulty: quiz.difficulty,
          questionCount: quiz.questionCount,
          status: a.status as AttemptStatus,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt?.toISOString() ?? null,
          score: a.score,
          total: a.total,
          percentage: a.percentage,
        }));
    },

    async summary(userId) {
      return withUser(db, userId, async (tx) => {
        const [created] = await tx.select({ n: sql<number>`count(*)::int` }).from(quizzes).where(and(eq(quizzes.userId, userId), eq(quizzes.status, "ready")));
        const [att] = await tx
          .select({
            n: sql<number>`count(*)::int`,
            avg: sql<number | null>`avg(${quizAttempts.percentage})::float8`,
            best: sql<number | null>`max(${quizAttempts.percentage})::float8`,
          })
          .from(quizAttempts)
          .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.status, ["submitted", "expired"])));
        // Real accuracy per topic across every finished attempt (each attempt covers every question of its quiz).
        const perTopic = await tx.execute<{ topic: string | null; total: number; correct: number }>(sql`
          select q.topic as topic, count(*)::int as total, count(*) filter (where a.is_correct)::int as correct
          from quiz_attempts t
          join quiz_questions q on q.quiz_id = t.quiz_id and q.user_id = t.user_id
          left join quiz_answers a on a.attempt_id = t.id and a.question_id = q.id
          where t.user_id = ${userId} and t.status in ('submitted', 'expired')
          group by q.topic`);
        const answered = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from quiz_answers a join quiz_attempts t on t.id = a.attempt_id
          where t.user_id = ${userId} and t.status in ('submitted', 'expired')`);
        const topics = topicPerformance(
          [...perTopic].flatMap((r) => [
            ...Array.from({ length: r.correct }, () => ({ topic: r.topic, isCorrect: true })),
            ...Array.from({ length: r.total - r.correct }, () => ({ topic: r.topic, isCorrect: false })),
          ]),
        );
        return {
          quizzesCreated: created?.n ?? 0,
          attemptsCompleted: att?.n ?? 0,
          averagePercentage: att?.avg === null || att?.avg === undefined ? null : roundPercent(att.avg),
          bestPercentage: att?.best ?? null,
          questionsAnswered: [...answered][0]?.n ?? 0,
          topics,
        };
      });
    },

    async topicSuggestions(userId, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .selectDistinct({ subject: conversations.subject, topic: conversations.topic })
          .from(conversations)
          .where(and(eq(conversations.userId, userId), sql`${conversations.subject} is not null`, sql`${conversations.deletedAt} is null`))
          .limit(limit),
      );
      return rows.filter((r): r is { subject: string; topic: string | null } => r.subject !== null);
    },
  };
}
