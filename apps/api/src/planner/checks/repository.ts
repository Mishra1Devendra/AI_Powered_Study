import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SessionCheckStatus } from "@copilot/shared";
import type { Database } from "../../db/client.js";
import { sessionChecks } from "../../db/schema/index.js";

/** A stored question INCLUDING its answer key. Never sent to the browser before the answers are submitted. */
export interface StoredCheckQuestion {
  id: string;
  text: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface CheckRecord {
  id: string;
  userId: string;
  sessionId: string;
  status: SessionCheckStatus;
  questions: StoredCheckQuestion[] | null;
  answers: Array<{ questionId: string; choice: number }> | null;
  score: number | null;
  error: string | null;
  isMock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckMeta {
  provider: string;
  model: string;
  isMock: boolean;
}

export interface CheckRepository {
  create(userId: string, sessionId: string): Promise<CheckRecord>;
  get(userId: string, checkId: string): Promise<CheckRecord | null>;
  /** The newest check for the session, any status. */
  latest(userId: string, sessionId: string): Promise<CheckRecord | null>;
  /** Questions of the student's earlier REAL-AI checks for this session (so a retry asks different ones; demo placeholders are not worth avoiding). */
  previousQuestionTexts(userId: string, sessionId: string, limit: number): Promise<string[]>;
  /** Checks started in the last 24 hours for this session. */
  countSince(userId: string, sessionId: string, since: Date): Promise<number>;
  hasPassed(userId: string, sessionId: string): Promise<boolean>;
  /** generating -> ready. False if the check was no longer generating. */
  setReady(userId: string, checkId: string, questions: StoredCheckQuestion[], meta: CheckMeta): Promise<boolean>;
  /** generating -> error. */
  setError(userId: string, checkId: string, error: string, meta?: CheckMeta): Promise<void>;
  /** Marks generating checks that no job here is working on (a restart, a crash) as errored. */
  failStale(userId: string, sessionId: string, olderThan: Date, keepIds: string[]): Promise<number>;
  /** ready -> passed | failed, exactly once (a second submission finds nothing to update). */
  submit(userId: string, checkId: string, answers: Array<{ questionId: string; choice: number }>, score: number, passed: boolean): Promise<CheckRecord | null>;
}

type Row = typeof sessionChecks.$inferSelect;
const toRecord = (r: Row): CheckRecord => ({
  id: r.id,
  userId: r.userId,
  sessionId: r.sessionId,
  status: r.status as SessionCheckStatus,
  questions: (r.questions as StoredCheckQuestion[] | null) ?? null,
  answers: (r.answers as Array<{ questionId: string; choice: number }> | null) ?? null,
  score: r.score,
  error: r.error,
  isMock: r.isMock,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * Server-only: this table holds answer keys and no client role can read it, so it uses the server's privileged connection.
 * Every query is scoped by the verified user id AND the id asked for, so one student can never reach another's check.
 */
export function createCheckRepository(db: Database): CheckRepository {
  const mine = (userId: string, id: string) => and(eq(sessionChecks.userId, userId), eq(sessionChecks.id, id));
  return {
    async create(userId, sessionId) {
      const [row] = await db.insert(sessionChecks).values({ userId, sessionId }).returning();
      return toRecord(row!);
    },
    async get(userId, checkId) {
      const [row] = await db.select().from(sessionChecks).where(mine(userId, checkId)).limit(1);
      return row ? toRecord(row) : null;
    },
    async latest(userId, sessionId) {
      const [row] = await db.select().from(sessionChecks).where(and(eq(sessionChecks.userId, userId), eq(sessionChecks.sessionId, sessionId))).orderBy(desc(sessionChecks.createdAt)).limit(1);
      return row ? toRecord(row) : null;
    },
    async previousQuestionTexts(userId, sessionId, limit) {
      const rows = await db.select({ questions: sessionChecks.questions }).from(sessionChecks).where(and(eq(sessionChecks.userId, userId), eq(sessionChecks.sessionId, sessionId), eq(sessionChecks.isMock, false))).orderBy(desc(sessionChecks.createdAt)).limit(6);
      return rows.flatMap((r) => ((r.questions as StoredCheckQuestion[] | null) ?? []).map((q) => q.text)).slice(0, limit);
    },
    async countSince(userId, sessionId, since) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(sessionChecks).where(and(eq(sessionChecks.userId, userId), eq(sessionChecks.sessionId, sessionId), gt(sessionChecks.createdAt, since)));
      return row?.n ?? 0;
    },
    async hasPassed(userId, sessionId) {
      const [row] = await db.select({ id: sessionChecks.id }).from(sessionChecks).where(and(eq(sessionChecks.userId, userId), eq(sessionChecks.sessionId, sessionId), eq(sessionChecks.status, "passed"))).limit(1);
      return Boolean(row);
    },
    async setReady(userId, checkId, questions, meta) {
      const rows = await db
        .update(sessionChecks)
        .set({ status: "ready", questions, provider: meta.provider, model: meta.model, isMock: meta.isMock, error: null, updatedAt: sql`now()` })
        .where(and(mine(userId, checkId), eq(sessionChecks.status, "generating")))
        .returning({ id: sessionChecks.id });
      return rows.length === 1;
    },
    async setError(userId, checkId, error, meta) {
      await db
        .update(sessionChecks)
        .set({ status: "error", error, ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}), updatedAt: sql`now()` })
        .where(and(mine(userId, checkId), eq(sessionChecks.status, "generating")));
    },
    async failStale(userId, sessionId, olderThan, keepIds) {
      const rows = await db
        .select({ id: sessionChecks.id })
        .from(sessionChecks)
        .where(and(eq(sessionChecks.userId, userId), eq(sessionChecks.sessionId, sessionId), eq(sessionChecks.status, "generating"), sql`${sessionChecks.updatedAt} < ${olderThan.toISOString()}`));
      const ids = rows.map((r) => r.id).filter((id) => !keepIds.includes(id));
      if (ids.length === 0) return 0;
      await db.update(sessionChecks).set({ status: "error", error: "Creating the questions was interrupted. Please try again.", updatedAt: sql`now()` }).where(and(eq(sessionChecks.userId, userId), inArray(sessionChecks.id, ids), eq(sessionChecks.status, "generating")));
      return ids.length;
    },
    async submit(userId, checkId, answers, score, passed) {
      const rows = await db
        .update(sessionChecks)
        .set({ status: passed ? "passed" : "failed", answers, score, submittedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(mine(userId, checkId), eq(sessionChecks.status, "ready")))
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}
