import { randomUUID } from "node:crypto";
import type { PlanStats } from "@copilot/shared";
import { EMPTY_STATS, type PlanRecord, type PlannerRepository, type SessionRecord } from "../repository.js";
import type { PlannedSession } from "../schedule.js";

type StoredSession = SessionRecord & { userId: string; createdAt: Date };

/**
 * In-memory PlannerRepository for tests. Mirrors the real one's rules: everything is scoped by user id
 * (another student's id behaves as "not found"), one active plan per student, a previous active plan is
 * archived (never deleted), and status changes only apply from the allowed current statuses.
 */
export function createInMemoryPlannerRepository(clock: () => Date = () => new Date()) {
  const plans: PlanRecord[] = [];
  const sessions: StoredSession[] = [];
  const timezones = new Map<string, string>();
  const subjects = new Map<string, string[]>();
  const knobs = { failComplete: false };

  const mine = (userId: string, planId: string) => plans.find((p) => p.id === planId && p.userId === userId);
  const strip = ({ userId: _u, createdAt: _c, ...s }: StoredSession): SessionRecord => ({ ...s });
  const touch = (p: PlanRecord) => (p.updatedAt = clock());
  const insert = (userId: string, planId: string, s: PlannedSession, rescheduledFromId: string | null = null): StoredSession => {
    const row: StoredSession = { id: randomUUID(), planId, userId, createdAt: clock(), ...s, status: "planned", startedAt: null, completedAt: null, rescheduledFromId };
    sessions.push(row);
    return row;
  };

  const repo: PlannerRepository = {
    async getTimezone(userId) {
      return timezones.get(userId) ?? "UTC";
    },
    async createPlan(p) {
      const plan: PlanRecord = { ...p, id: randomUUID(), status: "generating", error: null, summary: null, unscheduledTopics: [], isMock: false, model: null, createdAt: clock(), updatedAt: clock() };
      plans.unshift(plan);
      return { ...plan };
    },
    async findGenerating(userId) {
      const p = plans.find((x) => x.userId === userId && x.status === "generating");
      return p ? { ...p } : null;
    },
    async failStaleGenerating(userId, olderThan, keepIds) {
      let n = 0;
      for (const p of plans) {
        if (p.userId === userId && p.status === "generating" && p.updatedAt < olderThan && !keepIds.includes(p.id)) {
          p.status = "failed";
          p.error = "Creating the plan was interrupted. Please try again.";
          touch(p);
          n++;
        }
      }
      return n;
    },
    async completePlan(userId, planId, data) {
      if (knobs.failComplete) throw new Error("simulated database failure");
      const plan = mine(userId, planId);
      if (!plan || plan.status !== "generating") return false;
      for (const p of plans) if (p.userId === userId && p.status === "active") (p.status = "archived"), touch(p);
      for (const s of data.sessions) insert(userId, planId, s);
      Object.assign(plan, { status: "active", error: null, summary: data.summary, unscheduledTopics: data.unscheduled, model: data.model, isMock: data.isMock });
      touch(plan);
      return true;
    },
    async failPlan(userId, planId, error, meta) {
      const plan = mine(userId, planId);
      if (!plan || plan.status !== "generating") return;
      Object.assign(plan, { status: "failed", error: error.slice(0, 500), ...(meta ? { model: meta.model, isMock: meta.isMock } : {}) });
      touch(plan);
    },
    async getPlan(userId, planId) {
      const p = mine(userId, planId);
      return p ? { ...p } : null;
    },
    async getActivePlan(userId) {
      const p = plans.find((x) => x.userId === userId && x.status === "active");
      return p ? { ...p } : null;
    },
    async listPlans(userId, limit) {
      return plans.filter((p) => p.userId === userId).slice(0, limit).map((p) => ({ ...p }));
    },
    async listSessions(userId, planId) {
      return sessions
        .filter((s) => s.userId === userId && s.planId === planId)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.createdAt.getTime() - b.createdAt.getTime())
        .map(strip);
    },
    async getSession(userId, sessionId) {
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      return s ? strip(s) : null;
    },
    async updateSession(userId, sessionId, from, patch) {
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      if (!s || !from.includes(s.status)) return null;
      s.status = patch.status;
      if (patch.startedAt !== undefined) s.startedAt = patch.startedAt;
      if (patch.completedAt !== undefined) s.completedAt = patch.completedAt;
      return strip(s);
    },
    async rescheduleSession(userId, sessionId, from, replacement) {
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      if (!s || !from.includes(s.status)) return null;
      s.status = "rescheduled";
      const created = insert(userId, s.planId, replacement, s.id);
      return { original: strip(s), created: strip(created) };
    },
    async updatePlan(userId, planId, patch) {
      const p = mine(userId, planId);
      if (!p) return null;
      Object.assign(p, patch);
      touch(p);
      return { ...p };
    },
    async activatePlan(userId, planId) {
      const target = mine(userId, planId);
      if (!target || target.status !== "archived") return false;
      for (const p of plans) if (p.userId === userId && p.status === "active") (p.status = "archived"), touch(p);
      target.status = "active";
      touch(target);
      return true;
    },
    async statsFor(userId, planIds, today) {
      const out = new Map<string, PlanStats>();
      for (const id of planIds) {
        const list = sessions.filter((s) => s.userId === userId && s.planId === id && s.status !== "rescheduled");
        if (list.length === 0) continue;
        const stats = { ...EMPTY_STATS };
        for (const s of list) {
          stats.totalSessions++;
          stats.plannedMinutes += s.durationMinutes;
          if (s.status === "completed") (stats.completed++, (stats.completedMinutes += s.durationMinutes));
          if (s.status === "skipped") stats.skipped++;
          if (s.status === "missed" || ((s.status === "planned" || s.status === "in_progress") && s.date < today)) stats.missed++;
        }
        out.set(id, stats);
      }
      return out;
    },
    async usedSubjects(userId, limit) {
      return (subjects.get(userId) ?? []).slice(0, limit);
    },
  };

  return {
    repo,
    knobs,
    plans,
    sessions,
    setTimezone: (userId: string, tz: string) => timezones.set(userId, tz),
    setSubjects: (userId: string, list: string[]) => subjects.set(userId, list),
  };
}
