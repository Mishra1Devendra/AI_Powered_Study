import { randomUUID } from "node:crypto";
import {
  SESSION_CHECK_MAX_PER_DAY,
  SESSION_CHECK_PASS,
  SESSION_CHECK_QUESTIONS,
  type SessionCheck,
  type StudySession,
  type SubmitCheckInput,
} from "@copilot/shared";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../../errors.js";
import type { NotesRepository } from "../../notes/repository.js";
import { generateQuestions, QuizGenerationError } from "../../quiz/generate.js";
import type { LLMProvider } from "../../services/ai/index.js";
import type { PlannerService } from "../service.js";
import type { CheckRecord, CheckRepository, StoredCheckQuestion } from "./repository.js";

/** A check still "generating" this long after its last update with no job running here was interrupted (restart/crash). */
const STALE_AFTER_MS = 3 * 60_000;
/** The whole question-writing job is cut off after this long, so a stuck model can never hold a student. */
export const CHECK_JOB_DEADLINE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const AVOID_LIMIT = 20;

export interface CheckServiceDeps {
  repo: CheckRepository;
  planner: Pick<PlannerService, "checkableSession" | "completeVerified">;
  notes: NotesRepository;
  ai: LLMProvider;
  now?: () => Date;
  rng?: () => number;
  jobDeadlineMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Study check. Starting one is a deliberate click (one local AI call, never a timer or a retry loop); polling for the result is a
 * plain read. Grading happens here, from the stored key, and passing completes the session in the same request.
 */
export function createCheckService(deps: CheckServiceDeps) {
  const { repo, planner, notes, ai } = deps;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  /** Check id -> the job writing its questions, in THIS process. */
  const running = new Map<string, Promise<void>>();
  /** user:session -> a start already in flight, so a double click (two requests at once) shares ONE check and ONE AI call. */
  const starting = new Map<string, Promise<{ check: SessionCheck; created: boolean }>>();

  function toDto(c: CheckRecord): SessionCheck {
    const finished = c.status === "passed" || c.status === "failed";
    const answered = new Map((c.answers ?? []).map((a) => [a.questionId, a.choice]));
    return {
      id: c.id,
      sessionId: c.sessionId,
      status: c.status,
      total: SESSION_CHECK_QUESTIONS,
      passMark: SESSION_CHECK_PASS,
      // The answer key never leaves here before the answers are in.
      questions: c.questions && (c.status === "ready" || finished) ? c.questions.map((q) => ({ id: q.id, text: q.text, options: q.options })) : null,
      score: c.score,
      passed: finished ? c.status === "passed" : null,
      review: finished && c.questions ? c.questions.map((q) => ({ questionId: q.id, chosen: answered.get(q.id) ?? null, correctIndex: q.correctIndex, explanation: q.explanation })) : null,
      error: c.status === "error" ? (c.error ?? "The questions could not be created. Please try again.") : null,
      isMock: c.isMock,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async function reapStale(userId: string, sessionId: string) {
    await repo.failStale(userId, sessionId, new Date(now().getTime() - STALE_AFTER_MS), [...running.keys()]);
  }

  function runJob(userId: string, check: CheckRecord, subject: string, topic: string, avoid: string[]) {
    const job = (async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), deps.jobDeadlineMs ?? CHECK_JOB_DEADLINE_MS);
      try {
        const out = await generateQuestions(
          { ai, notes, rng: deps.rng ?? Math.random, signal: controller.signal },
          userId,
          { sourceType: "topic", subject, topic, focus: null, difficulty: "medium", count: SESSION_CHECK_QUESTIONS, types: ["mcq"], documentIds: [] },
          avoid,
        );
        const questions: StoredCheckQuestion[] = out.questions.map((q) => ({ id: randomUUID(), text: q.text, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation }));
        const ok = await repo.setReady(userId, check.id, questions, { provider: out.provider, model: out.model, isMock: out.isMock });
        if (!ok) onError(new Error("study check was no longer generating when its questions were ready"));
      } catch (e) {
        const known = e instanceof QuizGenerationError;
        if (!known) onError(e);
        await repo.setError(userId, check.id, known ? e.message : "Something went wrong while creating the questions. Please try again.", { provider: ai.name, model: ai.model, isMock: ai.isMock }).catch(onError);
      } finally {
        clearTimeout(deadline);
        running.delete(check.id);
      }
    })();
    running.set(check.id, job);
  }

  async function startOnce(userId: string, sessionId: string, unlimited: boolean): Promise<{ check: SessionCheck; created: boolean }> {
    const session = await planner.checkableSession(userId, sessionId);
    await reapStale(userId, sessionId);
    const latest = await repo.latest(userId, sessionId);
    if (latest && (latest.status === "generating" || latest.status === "ready")) return { check: toDto(latest), created: false };
    const since = new Date(now().getTime() - DAY_MS);
    // Administrators have no limits on AI use (students have a per-session cap here and a daily allowance for all AI actions).
    if (!unlimited && (await repo.countSince(userId, sessionId, since)) >= SESSION_CHECK_MAX_PER_DAY) {
      throw new AppError(429, "too_many_checks", `You've already tried ${SESSION_CHECK_MAX_PER_DAY} question sets for this session today. Revisit the topic and try again tomorrow.`);
    }
    const check = await repo.create(userId, sessionId);
    const avoid = await repo.previousQuestionTexts(userId, sessionId, AVOID_LIMIT);
    runJob(userId, check, session.subject, session.topic, avoid);
    return { check: toDto(check), created: true };
  }

  /**
   * Starts a check for a session, or returns the one already in progress, and says whether a NEW question set was started (one AI call)
   * or an existing one was returned (no AI call), so the caller only charges the daily AI allowance for real work. Concurrent calls
   * (a double click) share one start; only the first is reported as created.
   */
  async function startReporting(userId: string, sessionId: string, opts: { unlimited?: boolean } = {}): Promise<{ check: SessionCheck; created: boolean }> {
    const key = `${userId}:${sessionId}`;
    const inFlight = starting.get(key);
    if (inFlight) return inFlight.then((r) => ({ check: r.check, created: false }));
    const p = startOnce(userId, sessionId, opts.unlimited === true).finally(() => starting.delete(key));
    starting.set(key, p);
    return p;
  }

  return {
    /**
     * Starts a check for a session, or returns the one already in progress (so a double click or a reload never starts a second
     * AI call). A new set is only created when the student has none open.
     */
    start(userId: string, sessionId: string, opts: { unlimited?: boolean } = {}): Promise<SessionCheck> {
      return startReporting(userId, sessionId, opts).then((r) => r.check);
    },

    startReporting,

    /** The newest check for a session (to poll while generating, or to resume after a reload). Null when there never was one. */
    async latest(userId: string, sessionId: string): Promise<SessionCheck | null> {
      await reapStale(userId, sessionId);
      const latest = await repo.latest(userId, sessionId);
      return latest ? toDto(latest) : null;
    },

    /** Grades the answers from the stored key. At least SESSION_CHECK_PASS correct completes the session. */
    async submit(userId: string, sessionId: string, checkId: string, input: SubmitCheckInput): Promise<{ check: SessionCheck; session: StudySession | null }> {
      const check = await repo.get(userId, checkId);
      if (!check || check.sessionId !== sessionId) throw new NotFoundError("Question set not found.");
      if (check.status !== "ready" || !check.questions) {
        throw new ConflictError(check.status === "generating" ? "The questions are still being written." : check.status === "passed" || check.status === "failed" ? "These answers were already submitted. Start a new question set to try again." : "These questions can't be answered. Start a new set.");
      }
      const byId = new Map(input.answers.map((a) => [a.questionId, a.choice]));
      if (byId.size !== input.answers.length) throw new BadRequestError("Each question can be answered only once.");
      let score = 0;
      for (const q of check.questions) {
        const choice = byId.get(q.id);
        if (choice === undefined) throw new BadRequestError(`Answer all ${SESSION_CHECK_QUESTIONS} questions.`);
        if (choice >= q.options.length) throw new BadRequestError("One of the answers isn't one of the choices.");
        if (choice === q.correctIndex) score++;
      }
      if (byId.size !== check.questions.length) throw new BadRequestError("Those answers don't belong to this question set.");
      const passed = score >= SESSION_CHECK_PASS;
      const saved = await repo.submit(userId, checkId, input.answers, score, passed);
      if (!saved) throw new ConflictError("These answers were already submitted. Start a new question set to try again.");
      // Passing completes the session right here: there is no other route to "completed" while the gate is on.
      const session = passed ? await planner.completeVerified(userId, sessionId) : null;
      return { check: toDto(saved), session };
    },

    /** True once the student has passed a check for this session (the planner's gate for "complete"). */
    hasPassed: (userId: string, sessionId: string) => repo.hasPassed(userId, sessionId),

    /** Tests: wait for the question-writing jobs. */
    async whenIdle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}

export type CheckService = ReturnType<typeof createCheckService>;
