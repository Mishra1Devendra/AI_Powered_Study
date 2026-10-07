import { RECOMMENDATION_LIMITS, type ExplainResponse, type RecommendationAction, type RecommendationsResponse } from "@copilot/shared";
import { AppError } from "../errors.js";
import { daysBetween } from "../planner/dates.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { ProgressRepository } from "../progress/repository.js";
import type { LLMProvider } from "../services/ai/index.js";
import type { ExplainFacts } from "../services/ai/recommendations/prompt.js";
import { buildRecommendations, type EngineInput } from "./engine.js";
import { explainRecommendations } from "./explain.js";
import type { ExtrasRepository, PlanFact } from "./repository.js";

/** The optional AI explanation is cut off after this long, whatever the model is doing. */
export const EXPLAIN_DEADLINE_MS = 5 * 60_000;

export interface RecommendationServiceDeps {
  progress: ProgressRepository;
  extras: ExtrasRepository;
  ai: LLMProvider;
  /** Phase 11: finds a document that really covers a topic, so "Review notes" can be offered. Optional. */
  knowledge?: KnowledgeService | undefined;
  now?: () => Date;
  explainDeadlineMs?: number;
  onError?: (err: unknown) => void;
}

const UNAVAILABLE = "AI explanation is temporarily unavailable. Your recommendations are still available using your learning data.";

/**
 * Smart Revision. The recommendations are calculated from the student's own records by a deterministic engine - the
 * page works completely without AI, and the same data always gives the same answer. AI is used for exactly one
 * optional thing: when the student presses "Explain my priorities", ONE local model call puts the already-calculated
 * facts into friendlier words. Nothing here runs in the background, on page load, or on a schedule.
 */
export function createRecommendationService(deps: RecommendationServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  const busy = new Set<string>();

  /** Two reads on separate connections, in parallel: the Progress facts (all time) and the few extras. */
  async function compute(userId: string, limit: number): Promise<{ result: RecommendationsResponse; plan: PlanFact | null }> {
    const [progress, extras] = await Promise.all([deps.progress.load(userId, { now: now(), rangeDays: null, recent: false }), deps.extras.load(userId)]);
    const input: EngineInput = {
      today: progress.today,
      sessions: progress.data.sessions,
      attempts: progress.data.attempts,
      breakdown: progress.data.breakdown,
      viva: progress.data.viva,
      repeated: extras.repeated,
      sources: extras.sources,
      tutor: extras.tutor,
    };
    return { result: buildRecommendations(input, limit), plan: extras.plan };
  }

  /**
   * Adds a "Review notes" action where the student's own material really covers the topic: a ready document with a passage
   * containing ALL the topic's words (checked by the database, not guessed). Topics with no such document keep their
   * actions unchanged - a document association is never invented, and a failed lookup changes nothing.
   */
  async function withNotes(userId: string, result: RecommendationsResponse): Promise<RecommendationsResponse> {
    if (!deps.knowledge) return result;
    const topics = [...new Set(result.recommendations.filter((r) => r.topic && !r.actions.some((a) => a.kind === "notes")).map((r) => r.topic!))];
    if (topics.length === 0) return result;
    try {
      const found = new Map((await deps.knowledge.topicMatches(userId, topics)).map((m) => [m.topic, m]));
      return {
        ...result,
        recommendations: result.recommendations.map((r) => {
          const match = r.topic ? found.get(r.topic) : undefined;
          if (!match || r.actions.length >= 5) return r;
          const notes: RecommendationAction = { kind: "notes", label: "Review notes", subject: r.subject, topic: r.topic, count: null, draft: null, documentId: match.documentId, sessionId: null };
          return { ...r, actions: [...r.actions.slice(0, 1), notes, ...r.actions.slice(1)] };
        }),
      };
    } catch (err) {
      onError(err);
      return result;
    }
  }

  return {
    async list(userId: string, limit: number = RECOMMENDATION_LIMITS.defaultLimit): Promise<RecommendationsResponse> {
      return withNotes(userId, (await compute(userId, limit)).result);
    },

    /**
     * Optional AI wording for the top recommendations. The facts are recomputed on the server (nothing comes from the
     * client), at most ONE model call is made, and every failure is a normal "not available" answer, never an error page.
     */
    async explain(userId: string): Promise<ExplainResponse> {
      if (busy.has(userId)) throw new AppError(409, "explain_busy", "An explanation is already being written. Wait for it to finish.");
      busy.add(userId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.explainDeadlineMs ?? EXPLAIN_DEADLINE_MS);
      const none = (message: string): ExplainResponse => ({ available: false, message, overview: null, items: [], isMock: false, model: null });
      try {
        const { result, plan } = await compute(userId, RECOMMENDATION_LIMITS.explainCount);
        if (result.recommendations.length === 0) return none("There is nothing to explain yet. Complete a few quizzes or study sessions first.");
        const facts: ExplainFacts = {
          exam: plan ? { date: plan.examDate, daysLeft: daysBetween(result.today, plan.examDate) } : null,
          minutesPerDay: plan?.minutesPerDay ?? null,
          recommendations: result.recommendations.map((r) => ({ id: r.id, type: r.type, priority: r.priority, subject: r.subject, topic: r.topic, action: r.actionText, reason: r.reason, facts: r.facts })),
        };
        const outcome = await explainRecommendations(deps.ai, facts, controller.signal);
        if (!outcome.ok) return none(UNAVAILABLE);
        return { available: true, message: null, overview: outcome.value.overview, items: outcome.value.items, isMock: outcome.value.isMock, model: outcome.value.model };
      } catch (err) {
        // A database or unexpected error must not break the page either: the deterministic list is requested separately.
        onError(err);
        return none(UNAVAILABLE);
      } finally {
        clearTimeout(timer);
        busy.delete(userId);
      }
    },
  };
}

export type RecommendationService = ReturnType<typeof createRecommendationService>;
