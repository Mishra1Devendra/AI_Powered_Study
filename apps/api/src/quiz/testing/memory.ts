import { randomUUID } from "node:crypto";
import type { AttemptHistoryItem, AttemptStatus, PlayQuestion, Quiz, QuizSourceType, QuizSummary } from "@copilot/shared";
import type { NotesRepository } from "../../notes/repository.js";
import { roundPercent, topicPerformance } from "../grading.js";
import {
  sourceLabel,
  type AttemptRecord,
  type FinalizeData,
  type GenerationMeta,
  type NewQuestion,
  type NewQuiz,
  type QuizRepository,
  type StoredQuestion,
} from "../repository.js";

interface QuizEntry extends NewQuiz {
  id: string;
  status: "generating" | "ready" | "failed";
  error: string | null;
  provider: string | null;
  model: string | null;
  isMock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory QuizRepository for tests. Mirrors the real one's rules: everything is scoped by
 * user id (another student's id behaves as "not found"), one open attempt per quiz, and
 * finalising an attempt is a one-way, once-only operation.
 */
export function createInMemoryQuizRepository(notes: NotesRepository, clock: () => Date = () => new Date()) {
  const quizzes: QuizEntry[] = [];
  const questions: StoredQuestion[] = [];
  const attempts: (AttemptRecord & { userId: string })[] = [];
  const answers: { attemptId: string; questionId: string; userId: string; selected: number; isCorrect: boolean | null }[] = [];
  let suggestions: { userId: string; subject: string; topic: string | null }[] = [];
  const knobs = { failCreateAttempt: false };

  const mine = (userId: string, quizId: string) => quizzes.find((q) => q.id === quizId && q.userId === userId);

  async function toQuiz(q: QuizEntry): Promise<Quiz> {
    const docs: { id: string; title: string }[] = [];
    for (const id of q.documentIds) {
      const n = await notes.getNote(q.userId, id);
      if (n) docs.push({ id, title: n.title });
    }
    const done = attempts.filter((a) => a.quizId === q.id && a.status !== "in_progress");
    const best = done.reduce<number | null>((m, a) => (a.percentage === null ? m : Math.max(m ?? 0, a.percentage)), null);
    const last = done.map((a) => a.submittedAt).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      id: q.id,
      title: q.title,
      sourceType: q.sourceType,
      sourceLabel: sourceLabel(q.sourceType, q.subject, q.topic, docs.map((d) => d.title)),
      subject: q.subject,
      topic: q.topic,
      sources: docs,
      difficulty: q.difficulty,
      questionCount: q.questionCount,
      questionTypes: q.questionTypes,
      timeLimitMinutes: q.timeLimitMinutes,
      status: q.status,
      error: q.error,
      isMock: q.isMock,
      model: q.model,
      createdAt: q.createdAt.toISOString(),
      attemptCount: done.length,
      bestPercentage: best,
      lastAttemptAt: last?.toISOString() ?? null,
      inProgressAttemptId: attempts.find((a) => a.quizId === q.id && a.status === "in_progress")?.id ?? null,
    };
  }

  const repo: QuizRepository = {
    async createQuiz(input) {
      const entry: QuizEntry = { ...input, id: randomUUID(), status: "generating", error: null, provider: null, model: null, isMock: false, createdAt: clock(), updatedAt: clock() };
      quizzes.unshift(entry);
      return toQuiz(entry);
    },
    async findGenerating(userId) {
      const q = quizzes.find((x) => x.userId === userId && x.status === "generating");
      return q ? toQuiz(q) : null;
    },
    async failStaleGenerating(userId, olderThan, keepIds) {
      let n = 0;
      for (const q of quizzes) {
        if (q.userId === userId && q.status === "generating" && q.updatedAt < olderThan && !keepIds.includes(q.id)) {
          q.status = "failed";
          q.error = "Quiz generation was interrupted. Please try again.";
          n++;
        }
      }
      return n;
    },
    async completeGeneration(userId, quizId, qs: NewQuestion[], meta: GenerationMeta) {
      const q = mine(userId, quizId);
      if (!q || q.status !== "generating") return false;
      for (const nq of qs) questions.push({ ...nq, id: randomUUID(), quizId });
      Object.assign(q, { status: "ready", error: null, provider: meta.provider, model: meta.model, isMock: meta.isMock, updatedAt: clock() });
      return true;
    },
    async failGeneration(userId, quizId, error, meta) {
      const q = mine(userId, quizId);
      if (!q || q.status !== "generating") return;
      Object.assign(q, { status: "failed", error: error.slice(0, 500), updatedAt: clock(), ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}) });
    },
    async getQuiz(userId, quizId) {
      const q = mine(userId, quizId);
      return q ? toQuiz(q) : null;
    },
    async listQuizzes(userId, limit) {
      return Promise.all(quizzes.filter((q) => q.userId === userId).slice(0, limit).map(toQuiz));
    },
    async listPlayQuestions(userId, quizId): Promise<PlayQuestion[]> {
      if (!mine(userId, quizId)) return [];
      return questions
        .filter((q) => q.quizId === quizId)
        .sort((a, b) => a.order - b.order)
        // Deliberately drops correctIndex / explanation / sourceRef, like the real column grants.
        .map((q) => ({ id: q.id, order: q.order, type: q.type, text: q.text, options: q.options, difficulty: q.difficulty, topic: q.topic }));
    },
    async getFullQuestions(userId, quizId) {
      if (!mine(userId, quizId)) return [];
      return questions.filter((q) => q.quizId === quizId).sort((a, b) => a.order - b.order);
    },
    async getQuizConfig(userId, quizId) {
      const q = mine(userId, quizId);
      return q ? { ...q } : null;
    },
    async createAttempt(userId, quizId, questionOrder, expiresAt) {
      if (knobs.failCreateAttempt) throw new Error("unique violation");
      if (!mine(userId, quizId)) throw new Error("foreign key violation");
      if (attempts.some((a) => a.quizId === quizId && a.userId === userId && a.status === "in_progress")) throw new Error("unique violation");
      const a = { id: randomUUID(), userId, quizId, status: "in_progress" as AttemptStatus, startedAt: clock(), expiresAt, submittedAt: null, questionOrder, score: null, total: null, percentage: null, timeTakenSeconds: null };
      attempts.unshift(a);
      return a;
    },
    async findOpenAttempt(userId, quizId) {
      return attempts.find((a) => a.quizId === quizId && a.userId === userId && a.status === "in_progress") ?? null;
    },
    async getAttempt(userId, attemptId) {
      return attempts.find((a) => a.id === attemptId && a.userId === userId) ?? null;
    },
    async listAttemptsForQuiz(userId, quizId) {
      return attempts.filter((a) => a.quizId === quizId && a.userId === userId);
    },
    async saveAnswers(userId, attemptId, list) {
      const a = attempts.find((x) => x.id === attemptId && x.userId === userId);
      if (!a || a.status !== "in_progress") return false;
      for (const item of list) {
        const at = answers.findIndex((x) => x.attemptId === attemptId && x.questionId === item.questionId);
        if (item.selected === null) {
          if (at >= 0) answers.splice(at, 1);
        } else if (at >= 0) {
          answers[at]!.selected = item.selected;
        } else {
          answers.push({ attemptId, questionId: item.questionId, userId, selected: item.selected, isCorrect: null });
        }
      }
      return true;
    },
    async getAnswers(userId, attemptId) {
      return new Map(answers.filter((x) => x.attemptId === attemptId && x.userId === userId).map((x) => [x.questionId, x.selected]));
    },
    async finalizeAttempt(userId, attemptId, data: FinalizeData) {
      const a = attempts.find((x) => x.id === attemptId && x.userId === userId);
      if (!a || a.status !== "in_progress") return false;
      Object.assign(a, { status: data.status, submittedAt: data.submittedAt, score: data.score, total: data.total, percentage: data.percentage, timeTakenSeconds: data.timeTakenSeconds });
      for (const g of data.graded) {
        const row = answers.find((x) => x.attemptId === attemptId && x.questionId === g.questionId);
        if (row) row.isCorrect = g.isCorrect;
      }
      return true;
    },
    async listAttemptHistory(userId, limit): Promise<AttemptHistoryItem[]> {
      const out: AttemptHistoryItem[] = [];
      for (const a of attempts.filter((x) => x.userId === userId).slice(0, limit)) {
        const q = mine(userId, a.quizId);
        if (!q) continue;
        const dto = await toQuiz(q);
        out.push({
          id: a.id,
          quizId: a.quizId,
          quizTitle: dto.title,
          sourceType: dto.sourceType as QuizSourceType,
          sourceLabel: dto.sourceLabel,
          difficulty: dto.difficulty,
          questionCount: dto.questionCount,
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt?.toISOString() ?? null,
          score: a.score,
          total: a.total,
          percentage: a.percentage,
        });
      }
      return out;
    },
    async summary(userId): Promise<QuizSummary> {
      const done = attempts.filter((a) => a.userId === userId && a.status !== "in_progress");
      const rows = done.flatMap((a) =>
        questions
          .filter((q) => q.quizId === a.quizId)
          .map((q) => ({ topic: q.topic, isCorrect: answers.find((x) => x.attemptId === a.id && x.questionId === q.id)?.isCorrect === true })),
      );
      const pct = done.map((a) => a.percentage).filter((p): p is number => p !== null);
      return {
        quizzesCreated: quizzes.filter((q) => q.userId === userId && q.status === "ready").length,
        attemptsCompleted: done.length,
        averagePercentage: pct.length ? roundPercent(pct.reduce((s, p) => s + p, 0) / pct.length) : null,
        bestPercentage: pct.length ? Math.max(...pct) : null,
        questionsAnswered: answers.filter((x) => done.some((a) => a.id === x.attemptId)).length,
        topics: topicPerformance(rows),
      };
    },
    async topicSuggestions(userId, limit) {
      return suggestions.filter((s) => s.userId === userId).slice(0, limit).map(({ subject, topic }) => ({ subject, topic }));
    },
  };

  return {
    repo,
    knobs,
    /** Raw access for assertions (e.g. "no answer key in what the player received"). */
    state: { quizzes, questions, attempts, answers },
    setSuggestions: (list: typeof suggestions) => void (suggestions = list),
  };
}
