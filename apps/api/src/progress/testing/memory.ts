import { randomUUID } from "node:crypto";
import type { ActivityType, PlanStatus, SessionStatus } from "@copilot/shared";
import { todayIn } from "../../planner/dates.js";
import type { AttemptFact, BreakdownFact, LastViva, RecentSessionFact, SessionFact, VivaFact } from "../compute.js";
import { boundsForDays } from "../compute.js";
import { safeTimezone, type ProgressData, type ProgressRepository } from "../repository.js";

export interface SeedSession {
  /** Scheduled day (local calendar date). */
  date: string;
  status?: SessionStatus;
  planStatus?: PlanStatus;
  /** When it was completed; required for "completed". */
  completedAt?: Date;
  updatedAt?: Date;
  durationMinutes?: number;
  subject?: string;
  topic?: string;
  activityType?: ActivityType;
}

export interface SeedViva {
  subject?: string;
  topic?: string | null;
  status?: "in_progress" | "completed" | "abandoned";
  score?: number;
  completedAt?: Date;
  /** The four 0-10 averages of the viva's answers. */
  dims?: [number, number, number, number];
}

export interface SeedQuestion {
  topic?: string | null;
  difficulty?: "easy" | "medium" | "hard";
  /** true = answered correctly, false = answered wrongly, "skipped" = left unanswered. */
  result: boolean | "skipped";
}

export interface SeedAttempt {
  quizId?: string;
  title?: string;
  subject?: string | null;
  status?: "in_progress" | "submitted" | "expired";
  startedAt?: Date;
  submittedAt?: Date;
  questions: SeedQuestion[];
}

/**
 * In-memory ProgressRepository for tests. It mirrors the real queries: everything is scoped by user id,
 * dates are converted to the student's local day with the same rules the database uses, rescheduled
 * originals are left out, only finished attempts count, and unanswered questions are not correct.
 */
export function createInMemoryProgressRepository() {
  const sessions: Array<SeedSession & { userId: string; id: string }> = [];
  const attempts: Array<SeedAttempt & { userId: string; id: string }> = [];
  const vivas: Array<SeedViva & { userId: string; id: string }> = [];
  const timezones = new Map<string, string>();
  const calls = { load: 0 };

  const day = (d: Date, tz: string) => todayIn(tz, d);

  const repo: ProgressRepository = {
    async load(userId, q) {
      calls.load++;
      const timezone = safeTimezone(timezones.get(userId));
      const today = day(q.now, timezone);
      const bounds = boundsForDays(q.rangeDays, today);
      const since = bounds.prevFrom ?? bounds.from;

      const mine = sessions.filter((s) => s.userId === userId && (s.status ?? "planned") !== "rescheduled");
      const sessionFacts: SessionFact[] = mine
        .map((s) => ({
          id: s.id,
          date: s.date,
          completedDate: s.completedAt ? day(s.completedAt, timezone) : null,
          status: s.status ?? "planned",
          durationMinutes: s.durationMinutes ?? 30,
          subject: s.subject ?? "Physics",
          topic: s.topic ?? "Forces",
          activityType: s.activityType ?? "learn",
          planStatus: s.planStatus ?? "active",
        }))
        .filter((s) => since === null || s.date >= since || (s.completedDate !== null && s.completedDate >= since));

      const studyDates = [
        ...new Set(mine.filter((s) => s.status === "completed" && s.completedAt).map((s) => day(s.completedAt!, timezone))),
      ].sort();

      const finished = attempts.filter((a) => a.userId === userId && (a.status === "submitted" || a.status === "expired") && a.submittedAt);
      const toFact = (a: (typeof finished)[number]): AttemptFact => {
        const answered = a.questions.filter((x) => x.result !== "skipped");
        return {
          attemptId: a.id,
          quizId: a.quizId ?? a.id,
          quizTitle: a.title ?? "Quiz",
          subject: a.subject ?? null,
          at: a.submittedAt!,
          date: day(a.submittedAt!, timezone),
          percentage: a.questions.length ? Math.round((answered.filter((x) => x.result === true).length / a.questions.length) * 10000) / 100 : 0,
        };
      };
      const attemptFacts = finished.map(toFact).filter((a) => since === null || a.date >= since).sort((a, b) => a.at.getTime() - b.at.getTime());

      const breakdown: BreakdownFact[] = [];
      for (const a of finished) {
        if (bounds.from !== null && day(a.submittedAt!, timezone) < bounds.from) continue;
        const groups = new Map<string, BreakdownFact>();
        for (const x of a.questions) {
          const topic = x.topic ?? null;
          const difficulty = x.difficulty ?? "medium";
          const key = `${topic}|${difficulty}`;
          const g = groups.get(key) ?? { attemptId: a.id, topic, difficulty, total: 0, answered: 0, correct: 0 };
          g.total++;
          if (x.result !== "skipped") g.answered++;
          if (x.result === true) g.correct++;
          groups.set(key, g);
        }
        breakdown.push(...groups.values());
      }

      const started = attempts.filter((a) => a.userId === userId && a.startedAt);
      const quizzesAttempted = new Set(started.filter((a) => (bounds.from === null || day(a.startedAt!, timezone) >= bounds.from) && day(a.startedAt!, timezone) <= today).map((a) => a.quizId ?? a.id)).size;

      let recentSessions: RecentSessionFact[] = [];
      let recentAttempts: AttemptFact[] = [];
      if (q.recent) {
        recentSessions = mine
          .filter((s) => s.status === "completed" || s.status === "skipped")
          .map((s) => {
            const at = s.status === "completed" ? s.completedAt! : (s.updatedAt ?? new Date(`${s.date}T12:00:00Z`));
            return { id: s.id, status: s.status as "completed" | "skipped", at, date: day(at, timezone), subject: s.subject ?? "Physics", topic: s.topic ?? "Forces", durationMinutes: s.durationMinutes ?? 30 };
          })
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, 12);
        recentAttempts = finished.map(toFact).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 12);
      }

      const doneVivas = vivas.filter((v) => v.userId === userId && v.status === "completed" && v.completedAt);
      const vivaFacts: VivaFact[] = doneVivas
        .filter((v) => bounds.from === null || day(v.completedAt!, timezone) >= bounds.from)
        .map((v) => ({ id: v.id, subject: v.subject ?? "Chemistry", topic: v.topic ?? null, score: v.score ?? 0, date: day(v.completedAt!, timezone), at: v.completedAt!, c: v.dims?.[0] ?? null, p: v.dims?.[1] ?? null, l: v.dims?.[2] ?? null, f: v.dims?.[3] ?? null }));
      const newest = [...doneVivas].sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())[0];
      const lastViva: LastViva | null = newest ? { subject: newest.subject ?? "Chemistry", topic: newest.topic ?? null, score: newest.score ?? 0, total: doneVivas.length } : null;
      const data: ProgressData = { sessions: sessionFacts, studyDates, attempts: attemptFacts, breakdown, quizzesAttempted, recentSessions, recentAttempts, viva: vivaFacts, lastViva };
      return { timezone, today, data };
    },
  };

  return {
    repo,
    calls,
    setTimezone: (userId: string, tz: string) => timezones.set(userId, tz),
    addSession: (userId: string, s: SeedSession) => {
      const row = { userId, id: randomUUID(), ...s };
      sessions.push(row);
      return row.id;
    },
    /** A session completed at a given instant (the local day it counts for follows the student's timezone). */
    addCompleted: (userId: string, completedAt: Date, s: Partial<SeedSession> = {}) =>
      sessions.push({ userId, id: randomUUID(), date: completedAt.toISOString().slice(0, 10), status: "completed", completedAt, ...s }),
    addViva: (userId: string, v: SeedViva) => {
      const row = { userId, id: randomUUID(), status: "completed" as const, ...v };
      vivas.push(row);
      return row.id;
    },
    addAttempt: (userId: string, a: SeedAttempt) => {
      const row = { userId, id: randomUUID(), status: "submitted" as const, ...a };
      attempts.push(row);
      return row.id;
    },
  };
}
