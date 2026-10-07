import { and, asc, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { ActivityType, KnowledgeLevel, PlanStats, PlanStatus, PlanSubject, PreferredTime, Priority, SessionStatus } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { studentProfiles, studyPlans, studySessions } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";
import type { PlannedSession } from "./schedule.js";

export interface NewPlan {
  userId: string;
  title: string;
  examDate: string;
  startDate: string;
  targetScore: number | null;
  minutesPerDay: number;
  knowledgeLevel: KnowledgeLevel;
  studyDays: number[];
  preferredTime: PreferredTime;
  subjects: PlanSubject[];
  weakTopics: string[];
}

export interface PlanRecord extends NewPlan {
  id: string;
  status: PlanStatus;
  error: string | null;
  summary: string | null;
  unscheduledTopics: string[];
  isMock: boolean;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  planId: string;
  date: string;
  startTime: string | null;
  durationMinutes: number;
  subject: string;
  topic: string;
  activityType: ActivityType;
  priority: Priority;
  status: SessionStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  rescheduledFromId: string | null;
}

export interface CompletePlanData {
  summary: string | null;
  unscheduled: string[];
  sessions: PlannedSession[];
  provider: string;
  model: string;
  isMock: boolean;
}

export interface SessionPatch {
  status: SessionStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * Persistence for the study planner. Reads run through `withUser` (Row Level Security as the student).
 * Writes use the privileged connection, always scoped by the verified user id; composite foreign keys
 * make it impossible to attach a session to someone else's plan. Nothing is ever hard-deleted.
 */
export interface PlannerRepository {
  getTimezone(userId: string): Promise<string>;
  createPlan(plan: NewPlan): Promise<PlanRecord>;
  findGenerating(userId: string): Promise<PlanRecord | null>;
  failStaleGenerating(userId: string, olderThan: Date, keepIds: string[]): Promise<number>;
  /** Saves the sessions and makes this plan the active one, archiving the previous active plan, in ONE transaction. */
  completePlan(userId: string, planId: string, data: CompletePlanData): Promise<boolean>;
  failPlan(userId: string, planId: string, error: string, meta?: { provider: string; model: string; isMock: boolean }): Promise<void>;
  getPlan(userId: string, planId: string): Promise<PlanRecord | null>;
  getActivePlan(userId: string): Promise<PlanRecord | null>;
  listPlans(userId: string, limit: number): Promise<PlanRecord[]>;
  listSessions(userId: string, planId: string): Promise<SessionRecord[]>;
  getSession(userId: string, sessionId: string): Promise<SessionRecord | null>;
  /** Changes a session only if its current status is one of `from` (so concurrent clicks cannot double-apply). */
  updateSession(userId: string, sessionId: string, from: SessionStatus[], patch: SessionPatch): Promise<SessionRecord | null>;
  /** Marks the original "rescheduled" (kept as history) and creates its replacement, in one transaction. */
  rescheduleSession(userId: string, sessionId: string, from: SessionStatus[], replacement: PlannedSession): Promise<{ original: SessionRecord; created: SessionRecord } | null>;
  updatePlan(userId: string, planId: string, patch: { title?: string; examDate?: string; minutesPerDay?: number }): Promise<PlanRecord | null>;
  /** Makes an archived plan active again (the current active one is archived, not deleted). */
  activatePlan(userId: string, planId: string): Promise<boolean>;
  /** Real counts for several plans at once. `today` decides which planned sessions count as missed. */
  statsFor(userId: string, planIds: string[], today: string): Promise<Map<string, PlanStats>>;
  /** The suggestion list for the form: subjects the student already used with the AI Tutor. */
  usedSubjects(userId: string, limit: number): Promise<string[]>;
}

type PlanRow = typeof studyPlans.$inferSelect;
type SessionRow = typeof studySessions.$inferSelect;

const toPlan = (r: PlanRow): PlanRecord => ({
  id: r.id,
  userId: r.userId,
  title: r.title,
  examDate: r.examDate,
  startDate: r.startDate,
  targetScore: r.targetScore,
  minutesPerDay: r.minutesPerDay,
  knowledgeLevel: r.knowledgeLevel as KnowledgeLevel,
  studyDays: r.studyDays,
  preferredTime: r.preferredTime as PreferredTime,
  subjects: r.subjects as PlanSubject[],
  weakTopics: (r.weakTopics as string[] | null) ?? [],
  status: r.status as PlanStatus,
  error: r.generationError,
  summary: r.summary,
  unscheduledTopics: (r.unscheduledTopics as string[] | null) ?? [],
  isMock: r.isMock,
  model: r.model,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  planId: r.planId,
  date: r.scheduledDate,
  startTime: r.startTime ? r.startTime.slice(0, 5) : null,
  durationMinutes: r.durationMinutes,
  subject: r.subject,
  topic: r.topic,
  activityType: r.activityType as ActivityType,
  priority: r.priority as Priority,
  status: r.status as SessionStatus,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  rescheduledFromId: r.rescheduledFromId,
});

const sessionValues = (userId: string, planId: string, s: PlannedSession) => ({
  planId,
  userId,
  scheduledDate: s.date,
  startTime: s.startTime,
  durationMinutes: s.durationMinutes,
  subject: s.subject,
  topic: s.topic,
  activityType: s.activityType,
  priority: s.priority,
});

export const EMPTY_STATS: PlanStats = { totalSessions: 0, completed: 0, skipped: 0, missed: 0, plannedMinutes: 0, completedMinutes: 0 };

export function createPlannerRepository(db: Database): PlannerRepository {
  const one = async (userId: string, planId: string) => {
    const [row] = await withUser(db, userId, (tx) => tx.select().from(studyPlans).where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId))).limit(1));
    return row ? toPlan(row) : null;
  };

  return {
    async getTimezone(userId) {
      const [row] = await withUser(db, userId, (tx) => tx.select({ tz: studentProfiles.timezone }).from(studentProfiles).where(eq(studentProfiles.id, userId)).limit(1));
      return row?.tz || "UTC";
    },

    async createPlan(p) {
      const [row] = await db
        .insert(studyPlans)
        .values({
          userId: p.userId,
          title: p.title,
          examDate: p.examDate,
          startDate: p.startDate,
          targetScore: p.targetScore,
          minutesPerDay: p.minutesPerDay,
          knowledgeLevel: p.knowledgeLevel,
          studyDays: p.studyDays,
          preferredTime: p.preferredTime,
          subjects: p.subjects,
          weakTopics: p.weakTopics,
        })
        .returning();
      return toPlan(row!);
    },

    async findGenerating(userId) {
      const [row] = await db.select().from(studyPlans).where(and(eq(studyPlans.userId, userId), eq(studyPlans.status, "generating"))).orderBy(desc(studyPlans.createdAt)).limit(1);
      return row ? toPlan(row) : null;
    },

    async failStaleGenerating(userId, olderThan, keepIds) {
      const rows = await db
        .update(studyPlans)
        .set({ status: "failed", generationError: "Creating the plan was interrupted. Please try again." })
        .where(and(eq(studyPlans.userId, userId), eq(studyPlans.status, "generating"), lt(studyPlans.updatedAt, olderThan), ...(keepIds.length ? [notInArray(studyPlans.id, keepIds)] : [])))
        .returning({ id: studyPlans.id });
      return rows.length;
    },

    async completePlan(userId, planId, data) {
      return db.transaction(async (tx) => {
        const [locked] = await tx.select({ status: studyPlans.status }).from(studyPlans).where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId))).for("update");
        if (!locked || locked.status !== "generating") return false;
        // The previous active plan is archived (kept, with all its sessions), never deleted.
        await tx.update(studyPlans).set({ status: "archived", archivedAt: new Date() }).where(and(eq(studyPlans.userId, userId), eq(studyPlans.status, "active")));
        if (data.sessions.length > 0) await tx.insert(studySessions).values(data.sessions.map((s) => sessionValues(userId, planId, s)));
        await tx
          .update(studyPlans)
          .set({ status: "active", generationError: null, summary: data.summary, unscheduledTopics: data.unscheduled, provider: data.provider, model: data.model, isMock: data.isMock })
          .where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId)));
        return true;
      });
    },

    async failPlan(userId, planId, error, meta) {
      await db
        .update(studyPlans)
        .set({ status: "failed", generationError: error.slice(0, 500), ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}) })
        .where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId), eq(studyPlans.status, "generating")));
    },

    getPlan: one,

    async getActivePlan(userId) {
      const [row] = await withUser(db, userId, (tx) => tx.select().from(studyPlans).where(and(eq(studyPlans.userId, userId), eq(studyPlans.status, "active"))).limit(1));
      return row ? toPlan(row) : null;
    },

    async listPlans(userId, limit) {
      const rows = await withUser(db, userId, (tx) => tx.select().from(studyPlans).where(eq(studyPlans.userId, userId)).orderBy(desc(studyPlans.createdAt)).limit(limit));
      return rows.map(toPlan);
    },

    async listSessions(userId, planId) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(studySessions)
          .where(and(eq(studySessions.planId, planId), eq(studySessions.userId, userId)))
          .orderBy(asc(studySessions.scheduledDate), asc(studySessions.startTime), asc(studySessions.createdAt)),
      );
      return rows.map(toSession);
    },

    async getSession(userId, sessionId) {
      const [row] = await withUser(db, userId, (tx) => tx.select().from(studySessions).where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId))).limit(1));
      return row ? toSession(row) : null;
    },

    async updateSession(userId, sessionId, from, patch) {
      const [row] = await db
        .update(studySessions)
        .set({
          status: patch.status,
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        })
        .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId), inArray(studySessions.status, from)))
        .returning();
      return row ? toSession(row) : null;
    },

    async rescheduleSession(userId, sessionId, from, replacement) {
      return db.transaction(async (tx) => {
        const [original] = await tx
          .update(studySessions)
          .set({ status: "rescheduled" })
          .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, userId), inArray(studySessions.status, from)))
          .returning();
        if (!original) return null;
        const [created] = await tx
          .insert(studySessions)
          .values({ ...sessionValues(userId, original.planId, replacement), rescheduledFromId: original.id })
          .returning();
        return { original: toSession(original), created: toSession(created!) };
      });
    },

    async updatePlan(userId, planId, patch) {
      const [row] = await db
        .update(studyPlans)
        .set(patch)
        .where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId)))
        .returning();
      return row ? toPlan(row) : null;
    },

    async activatePlan(userId, planId) {
      return db.transaction(async (tx) => {
        const [target] = await tx.select({ status: studyPlans.status }).from(studyPlans).where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId))).for("update");
        if (!target || target.status !== "archived") return false;
        await tx.update(studyPlans).set({ status: "archived", archivedAt: new Date() }).where(and(eq(studyPlans.userId, userId), eq(studyPlans.status, "active")));
        await tx.update(studyPlans).set({ status: "active", archivedAt: null }).where(and(eq(studyPlans.id, planId), eq(studyPlans.userId, userId)));
        return true;
      });
    },

    async statsFor(userId, planIds, today) {
      const out = new Map<string, PlanStats>();
      if (planIds.length === 0) return out;
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select({
            planId: studySessions.planId,
            total: sql<number>`count(*) filter (where ${studySessions.status} <> 'rescheduled')::int`,
            completed: sql<number>`count(*) filter (where ${studySessions.status} = 'completed')::int`,
            skipped: sql<number>`count(*) filter (where ${studySessions.status} = 'skipped')::int`,
            missed: sql<number>`count(*) filter (where ${studySessions.status} = 'missed' or (${studySessions.status} in ('planned', 'in_progress') and ${studySessions.scheduledDate} < ${today}))::int`,
            plannedMinutes: sql<number>`coalesce(sum(${studySessions.durationMinutes}) filter (where ${studySessions.status} <> 'rescheduled'), 0)::int`,
            completedMinutes: sql<number>`coalesce(sum(${studySessions.durationMinutes}) filter (where ${studySessions.status} = 'completed'), 0)::int`,
          })
          .from(studySessions)
          .where(and(eq(studySessions.userId, userId), inArray(studySessions.planId, planIds)))
          .groupBy(studySessions.planId),
      );
      for (const r of rows) out.set(r.planId, { totalSessions: r.total, completed: r.completed, skipped: r.skipped, missed: r.missed, plannedMinutes: r.plannedMinutes, completedMinutes: r.completedMinutes });
      return out;
    },

    async usedSubjects(userId, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ subject: string }>(sql`
          select distinct subject from public.conversations
          where user_id = ${userId} and subject is not null and deleted_at is null
          limit ${limit}`),
      );
      return [...rows].map((r) => r.subject).filter(Boolean);
    },
  };
}
