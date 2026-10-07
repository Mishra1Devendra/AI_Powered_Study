import {
  CHECK_REQUIRED_CODE,
  CHECK_REQUIRED_MESSAGE,
  PROGRESS_THRESHOLDS,
  PLANNER_LIMITS,
  type PlanDetailResponse,
  type PlanInput,
  type PlanListResponse,
  type PlanOptions,
  type PlanProgress,
  type PlanStats,
  type SessionAction,
  type SessionActionResponse,
  type SessionStatus,
  type StudyPlan,
  type StudySession,
  type UpdatePlanInput,
} from "@copilot/shared";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { LLMProvider } from "../services/ai/index.js";
import { addDays, daysBetween, isoWeekday, todayIn } from "./dates.js";
import { generatePlan, PlanGenerationError } from "./generate.js";
import { EMPTY_STATS, type PlanRecord, type PlannerRepository, type SessionRecord } from "./repository.js";
import { PlanInputError, studyDates, validateSchedule, type PlannedSession } from "./schedule.js";

/** A plan still "generating" this long after creation, with no job running here, was interrupted (server restart). */
const STALE_AFTER_MS = 2 * 60_000;
/** The whole generation job is cut off after this long, so a stuck model can never block a student. */
export const PLAN_JOB_DEADLINE_MS = 20 * 60_000;
const LIST_LIMIT = 30;
// One shared definition of "weak" for the whole app (see packages/shared/src/progress.ts).
const WEAK_MIN_QUESTIONS = PROGRESS_THRESHOLDS.minQuestionsForMastery;
const WEAK_BELOW_PERCENT = PROGRESS_THRESHOLDS.weakBelow;
const MAX_WEAK_TOPICS = 6;

export interface WeakTopic {
  topic: string;
  correct: number;
  total: number;
  percentage: number;
}

export interface PlannerServiceDeps {
  repo: PlannerRepository;
  ai: LLMProvider;
  /** Real per-topic quiz accuracy for the student (from the quiz module). */
  quizTopics: (userId: string) => Promise<Array<{ topic: string | null; correct: number; total: number; percentage: number }>>;
  now?: () => Date;
  jobDeadlineMs?: number;
  onError?: (err: unknown) => void;
  /**
   * Study check: when given, a session can only be completed after the student has PASSED its 5-question check
   * (the check service completes the session itself through `completeVerified`). Absent = no gate (older tests).
   */
  checkGate?: (userId: string, sessionId: string) => Promise<boolean>;
}

/** What to show for a session: a planned one whose day has passed is "missed" - nothing is written for that. */
export const effectiveStatus = (s: Pick<SessionRecord, "status" | "date">, today: string): SessionStatus =>
  (s.status === "planned" || s.status === "in_progress") && s.date < today ? "missed" : s.status;

/** Statuses that still occupy time on their day. */
const OCCUPIES: SessionStatus[] = ["planned", "in_progress", "completed"];

export function createPlannerService(deps: PlannerServiceDeps) {
  const { repo, ai } = deps;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  const running = new Map<string, Promise<void>>();
  const progress = new Map<string, PlanProgress["stage"]>();

  const today = async (userId: string) => {
    const timezone = await repo.getTimezone(userId);
    return { today: todayIn(timezone, now()), timezone };
  };

  function toPlanDto(p: PlanRecord, stats: PlanStats = EMPTY_STATS): StudyPlan {
    return {
      id: p.id,
      title: p.title,
      examDate: p.examDate,
      startDate: p.startDate,
      targetScore: p.targetScore,
      minutesPerDay: p.minutesPerDay,
      knowledgeLevel: p.knowledgeLevel,
      studyDays: p.studyDays,
      preferredTime: p.preferredTime,
      subjects: p.subjects,
      status: p.status,
      error: p.error,
      summary: p.summary,
      unscheduledTopics: p.unscheduledTopics,
      weakTopics: p.weakTopics,
      isMock: p.isMock,
      model: p.model,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      stats,
      ...(p.status === "generating" && progress.has(p.id) ? { progress: { stage: progress.get(p.id)! } } : {}),
    };
  }

  function toSessionDto(s: SessionRecord, day: string, all: readonly SessionRecord[]): StudySession {
    return {
      id: s.id,
      planId: s.planId,
      date: s.date,
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      subject: s.subject,
      topic: s.topic,
      activityType: s.activityType,
      priority: s.priority,
      status: s.status,
      effectiveStatus: effectiveStatus(s, day),
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
      rescheduledFromId: s.rescheduledFromId,
      rescheduledToId: all.find((x) => x.rescheduledFromId === s.id)?.id ?? null,
    };
  }

  async function weakTopics(userId: string): Promise<WeakTopic[]> {
    const rows = await deps.quizTopics(userId);
    return rows
      .filter((r): r is WeakTopic => r.topic !== null && r.total >= WEAK_MIN_QUESTIONS && r.percentage < WEAK_BELOW_PERCENT)
      .sort((a, b) => a.percentage - b.percentage)
      .slice(0, MAX_WEAK_TOPICS);
  }

  /** Date checks that need the student's "today". */
  function checkExamDate(examDate: string, day: string) {
    if (examDate <= day) throw new BadRequestError("The exam date must be after today.");
    if (daysBetween(day, examDate) > PLANNER_LIMITS.maxPlanDays) throw new BadRequestError(`The exam date must be within ${PLANNER_LIMITS.maxPlanDays} days.`);
  }

  async function reapStale(userId: string, plans: PlanRecord[]) {
    const cutoff = now().getTime() - STALE_AFTER_MS;
    if (!plans.some((p) => p.status === "generating" && !running.has(p.id) && p.createdAt.getTime() < cutoff)) return false;
    await repo.failStaleGenerating(userId, new Date(cutoff), [...running.keys()]);
    return true;
  }

  async function startGeneration(userId: string, input: PlanInput): Promise<StudyPlan> {
    const { today: day } = await today(userId);
    checkExamDate(input.examDate, day);
    if (studyDates(day, input.examDate, input.studyDays).length === 0) {
      throw new BadRequestError("There are no study days between today and your exam on the days you chose. Pick more days or a later exam date.");
    }
    await repo.failStaleGenerating(userId, new Date(now().getTime() - STALE_AFTER_MS), [...running.keys()]);
    const busy = await repo.findGenerating(userId);
    if (busy) throw new AppError(409, "generation_in_progress", "A study plan is already being created. Wait for it to finish first.", { planId: busy.id });

    const weak = (await weakTopics(userId)).map((w) => w.topic);
    const plan = await repo.createPlan({ userId, ...input, startDate: day, weakTopics: weak });

    const job = (async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), deps.jobDeadlineMs ?? PLAN_JOB_DEADLINE_MS);
      try {
        const out = await generatePlan({ ai, signal: controller.signal, onProgress: (s) => progress.set(plan.id, s) }, { input, startDate: day, weakTopics: weak });
        progress.set(plan.id, "saving");
        await repo.completePlan(userId, plan.id, { summary: out.topicPlan.summary, unscheduled: out.schedule.unscheduled, sessions: out.schedule.sessions, provider: out.provider, model: out.model, isMock: out.isMock });
      } catch (e) {
        const known = e instanceof PlanGenerationError || e instanceof PlanInputError;
        if (!known) onError(e);
        await repo
          .failPlan(userId, plan.id, known ? e.message : "Something went wrong while creating the plan. Please try again.", { provider: ai.name, model: ai.model, isMock: ai.isMock })
          .catch(onError);
      } finally {
        clearTimeout(deadline);
        running.delete(plan.id);
        progress.delete(plan.id);
      }
    })();
    running.set(plan.id, job);
    return toPlanDto(plan);
  }

  async function ownPlan(userId: string, planId: string) {
    const plan = await repo.getPlan(userId, planId);
    if (!plan) throw new NotFoundError("Study plan not found.");
    return plan;
  }

  /** Free capacity on a day for a session, using the plan's daily limit. */
  function fits(planSessions: SessionRecord[], date: string, candidate: PlannedSession, plan: PlanRecord, ignoreId?: string): boolean {
    const sameDay = planSessions.filter((s) => s.date === date && s.id !== ignoreId && OCCUPIES.includes(s.status));
    const planned: PlannedSession[] = [...sameDay.map((s) => ({ ...s })), candidate];
    return validateSchedule(planned, { startDate: date, examDate: plan.examDate, minutesPerDay: plan.minutesPerDay, subjects: plan.subjects.map((s) => s.name) }).length === 0;
  }

  return {
    async whenIdle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },

    async options(userId: string): Promise<PlanOptions> {
      const [{ today: day, timezone }, weak, subjects] = await Promise.all([today(userId), weakTopics(userId), repo.usedSubjects(userId, 12)]);
      return { subjects, weakTopics: weak, today: day, timezone };
    },

    generate: startGeneration,

    /** A NEW plan from an existing plan's settings. The old plan stays active until the new one is ready, then it is archived (kept). */
    async regenerate(userId: string, planId: string): Promise<StudyPlan> {
      const old = await ownPlan(userId, planId);
      return startGeneration(userId, {
        title: old.title,
        examDate: old.examDate,
        targetScore: old.targetScore,
        minutesPerDay: old.minutesPerDay,
        knowledgeLevel: old.knowledgeLevel,
        subjects: old.subjects,
        studyDays: old.studyDays,
        preferredTime: old.preferredTime,
      });
    },

    async list(userId: string): Promise<PlanListResponse> {
      const { today: day } = await today(userId);
      let plans = await repo.listPlans(userId, LIST_LIMIT);
      if (await reapStale(userId, plans)) plans = await repo.listPlans(userId, LIST_LIMIT);
      const stats = await repo.statsFor(userId, plans.filter((p) => p.status === "active" || p.status === "archived").map((p) => p.id), day);
      return { plans: plans.map((p) => toPlanDto(p, stats.get(p.id))), activePlanId: plans.find((p) => p.status === "active")?.id ?? null, today: day };
    },

    async detail(userId: string, planId: string): Promise<PlanDetailResponse> {
      const { today: day, timezone } = await today(userId);
      let plan = await ownPlan(userId, planId);
      if (await reapStale(userId, [plan])) plan = await ownPlan(userId, planId);
      // While the plan is being made there are no sessions yet: polling stays one cheap query.
      if (plan.status === "generating" || plan.status === "failed") return { plan: toPlanDto(plan), sessions: [], today: day, timezone };
      const sessions = await repo.listSessions(userId, planId);
      const stats = (await repo.statsFor(userId, [planId], day)).get(planId);
      return { plan: toPlanDto(plan, stats), sessions: sessions.map((s) => toSessionDto(s, day, sessions)), today: day, timezone };
    },

    async update(userId: string, planId: string, patch: UpdatePlanInput): Promise<StudyPlan> {
      const plan = await ownPlan(userId, planId);
      if (plan.status !== "active" && plan.status !== "archived") throw new ConflictError("This plan cannot be edited right now.");
      const { today: day } = await today(userId);
      if (patch.examDate !== undefined && patch.examDate !== plan.examDate) {
        checkExamDate(patch.examDate, day);
        if (daysBetween(plan.startDate, patch.examDate) > 366) throw new BadRequestError("That exam date is too far from the plan's start. Create a new plan instead.");
        if (patch.examDate < plan.examDate) {
          const after = (await repo.listSessions(userId, planId)).filter((s) => s.date >= patch.examDate! && (s.status === "planned" || s.status === "in_progress"));
          if (after.length > 0) {
            throw new AppError(409, "sessions_after_exam", `${after.length} planned session${after.length === 1 ? " is" : "s are"} scheduled on or after that date. Regenerate the plan for the new date, or reschedule those sessions first.`);
          }
        }
      }
      const updated = await repo.updatePlan(userId, planId, patch);
      if (!updated) throw new NotFoundError("Study plan not found.");
      const stats = (await repo.statsFor(userId, [planId], day)).get(planId);
      return toPlanDto(updated, stats);
    },

    async activate(userId: string, planId: string): Promise<StudyPlan> {
      const plan = await ownPlan(userId, planId);
      if (plan.status === "active") return toPlanDto(plan);
      if (plan.status !== "archived") throw new ConflictError("Only a previous (archived) plan can be made active again.");
      if (!(await repo.activatePlan(userId, planId))) throw new ConflictError("This plan could not be made active. Please try again.");
      return toPlanDto((await ownPlan(userId, planId))!);
    },

    async sessionAction(userId: string, sessionId: string, action: SessionAction, body: { date?: string | undefined }): Promise<SessionActionResponse> {
      const session = await repo.getSession(userId, sessionId);
      if (!session) throw new NotFoundError("Study session not found.");
      const plan = await ownPlan(userId, session.planId);
      if (plan.status !== "active") throw new ConflictError("This plan is not your active plan, so its sessions cannot be changed. Make it active first.");
      const { today: day } = await today(userId);
      const all = await repo.listSessions(userId, plan.id);
      const dto = (s: SessionRecord, list: readonly SessionRecord[] = all) => toSessionDto(s, day, list);
      const conflict = (msg: string) => new ConflictError(msg);
      const at = now();

      if (action === "start") {
        const r = await repo.updateSession(userId, sessionId, ["planned"], { status: "in_progress", startedAt: at });
        if (!r) throw conflict(session.status === "in_progress" ? "This session is already in progress." : "Only a planned session can be started.");
        return { session: dto(r), created: null };
      }
      if (action === "complete") {
        if (deps.checkGate && !(await deps.checkGate(userId, sessionId))) throw new AppError(409, CHECK_REQUIRED_CODE, CHECK_REQUIRED_MESSAGE);
        const r = await repo.updateSession(userId, sessionId, ["planned", "in_progress"], { status: "completed", completedAt: at, ...(session.startedAt ? {} : { startedAt: at }) });
        if (!r) throw conflict("Only a planned or started session can be completed.");
        return { session: dto(r), created: null };
      }
      if (action === "skip") {
        const r = await repo.updateSession(userId, sessionId, ["planned", "in_progress"], { status: "skipped" });
        if (!r) throw conflict("Only a planned or started session can be skipped.");
        return { session: dto(r), created: null };
      }
      if (action === "miss") {
        if (session.date >= day) throw conflict("This session's day has not passed yet, so it is not missed.");
        const r = await repo.updateSession(userId, sessionId, ["planned", "in_progress"], { status: "missed" });
        if (!r) throw conflict("Only an unfinished session from a past day can be kept as missed.");
        return { session: dto(r), created: null };
      }

      // reschedule: the original is kept (status "rescheduled") and a new planned session is created.
      const movable: SessionStatus[] = ["planned", "in_progress", "skipped", "missed"];
      if (!movable.includes(session.status)) throw conflict("This session cannot be rescheduled.");
      const candidate = (date: string): PlannedSession => ({ date, startTime: null, durationMinutes: session.durationMinutes, subject: session.subject, topic: session.topic, activityType: session.activityType, priority: session.priority });
      let target = body.date;
      if (target) {
        if (target < day) throw new BadRequestError("Pick today or a later date.");
        if (target >= plan.examDate) throw new BadRequestError("Pick a date before your exam.");
        if (target === session.date && session.status !== "missed" && session.status !== "skipped") throw new BadRequestError("The session is already on that date.");
        if (!fits(all, target, candidate(target), plan, session.id)) throw conflict(`That day has no room for another ${session.durationMinutes}-minute session within your ${plan.minutesPerDay} minutes a day.`);
      } else {
        // The first day with room: study days first, then any day before the exam.
        const from = session.date >= day ? addDays(session.date, 1) : day;
        const days: string[] = [];
        for (let d = from; d < plan.examDate; d = addDays(d, 1)) days.push(d);
        const studyDay = new Set(plan.studyDays);
        target =
          days.find((d) => studyDay.has(isoWeekday(d)) && fits(all, d, candidate(d), plan, session.id)) ??
          days.find((d) => fits(all, d, candidate(d), plan, session.id));
        if (!target) throw conflict("There is no free time left before your exam for this session. You can keep it as missed instead.");
      }
      const moved = await repo.rescheduleSession(userId, sessionId, movable, candidate(target));
      if (!moved) throw conflict("This session changed in the meantime. Refresh and try again.");
      const after = [...all.filter((s) => s.id !== moved.original.id), moved.original, moved.created];
      return { session: dto(moved.original, after), created: dto(moved.created, after) };
    },

    /**
     * The student's own session, for a study check: it must belong to their ACTIVE plan and still be open (planned or started).
     * Anything else is refused with a message the student can act on.
     */
    async checkableSession(userId: string, sessionId: string): Promise<SessionRecord> {
      const session = await repo.getSession(userId, sessionId);
      if (!session) throw new NotFoundError("Study session not found.");
      const plan = await ownPlan(userId, session.planId);
      if (plan.status !== "active") throw new ConflictError("This plan is not your active plan, so its sessions cannot be changed. Make it active first.");
      if (session.status !== "planned" && session.status !== "in_progress") throw new ConflictError(session.status === "completed" ? "This session is already completed." : "Only a planned or started session can be checked.");
      return session;
    },

    /** Completes a session whose check was passed. Only the study-check service calls this. */
    async completeVerified(userId: string, sessionId: string): Promise<StudySession | null> {
      const session = await repo.getSession(userId, sessionId);
      if (!session) throw new NotFoundError("Study session not found.");
      const at = now();
      const done = await repo.updateSession(userId, sessionId, ["planned", "in_progress"], { status: "completed", completedAt: at, ...(session.startedAt ? {} : { startedAt: at }) });
      if (!done) return null;
      const { today: day } = await today(userId);
      return toSessionDto(done, day, await repo.listSessions(userId, session.planId));
    },

    /** Today's sessions of the active plan, for the dashboard. Null when the student has no active plan. */
    /**
     * What needs attention in the active plan (for in-app notifications): today's unfinished sessions and unfinished sessions
     * of past days. Read-only; null when the student has no active plan.
     */
    async openSessions(userId: string) {
      const plan = await repo.getActivePlan(userId);
      if (!plan) return null;
      const { today: day } = await today(userId);
      const open = (await repo.listSessions(userId, plan.id)).filter((s) => s.status === "planned" || s.status === "in_progress");
      return {
        day,
        today: open.filter((s) => s.date === day),
        missed: open.filter((s) => s.date < day).sort((a, b) => b.date.localeCompare(a.date)),
      };
    },

    async todayForDashboard(userId: string) {
      const plan = await repo.getActivePlan(userId);
      if (!plan) return null;
      const { today: day } = await today(userId);
      const sessions = (await repo.listSessions(userId, plan.id)).filter((s) => s.date === day && OCCUPIES.includes(s.status));
      return { plan, sessions };
    },
  };
}

export type PlannerService = ReturnType<typeof createPlannerService>;
