import type {
  AttemptHistoryItem,
  AttemptView,
  GenerateQuizInput,
  PlayQuestion,
  Quiz,
  QuizDetailResponse,
  QuizOptions,
  QuizResult,
  QuizSummary,
  ReviewItem,
  SaveAnswersInput,
  SubmitAttemptInput,
} from "@copilot/shared";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { NotesRepository } from "../notes/repository.js";
import type { LLMProvider } from "../services/ai/index.js";
import { generateQuestions, QuizGenerationError, type GenerationConfig, type GenerationProgress } from "./generate.js";
import { gradeAnswers, roundPercent, topicPerformance } from "./grading.js";
import type { AttemptRecord, QuizRepository, StoredQuestion } from "./repository.js";
import { shuffled } from "./validate.js";

/** After the deadline, a submission is still accepted for this long (network latency), then the attempt is closed as expired. */
export const DEADLINE_GRACE_MS = 15_000;
/** A quiz still "generating" this long after its last update with no job running here was interrupted. */
const STALE_AFTER_MS = 2 * 60_000;
const LIST_LIMIT = 50;
const HISTORY_LIMIT = 100;
const AVOID_LIMIT = 30;
/** The whole job (all batches) is cut off after this long, so a stuck model can never block a student. */
export const JOB_DEADLINE_MS = 40 * 60_000;

export interface QuizServiceDeps {
  repo: QuizRepository;
  notes: NotesRepository;
  ai: LLMProvider;
  now?: () => Date;
  rng?: () => number;
  /** Whole-job time limit (tests shorten it). */
  jobDeadlineMs?: number;
  /** Log a background failure (never shown to students). */
  onError?: (err: unknown) => void;
}

const err = (status: number, code: string, message: string) => new AppError(status, code, message);

export function createQuizService(deps: QuizServiceDeps) {
  const { repo, notes, ai } = deps;
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const onError = deps.onError ?? (() => undefined);

  /** Generation jobs running in THIS process (a student can only have one at a time). */
  const running = new Map<string, Promise<void>>();
  /** Live state of those jobs, shown to the student while they wait. Lives only as long as the job. */
  const progress = new Map<string, GenerationProgress>();

  const withProgress = (q: Quiz): Quiz => (q.status === "generating" && progress.has(q.id) ? { ...q, progress: progress.get(q.id)! } : q);

  /**
   * A quiz that says "generating" but is not being worked on by this process (the server restarted) and has
   * been that way for a while can never finish. Mark it failed - but only when we actually see such a quiz,
   * so ordinary polling does no extra database writes.
   */
  async function reapStale(userId: string, quizzes: Quiz[]): Promise<boolean> {
    const cutoff = now().getTime() - STALE_AFTER_MS;
    const stuck = quizzes.some((q) => q.status === "generating" && !running.has(q.id) && new Date(q.createdAt).getTime() < cutoff);
    if (!stuck) return false;
    await repo.failStaleGenerating(userId, new Date(cutoff), [...running.keys()]);
    return true;
  }

  const expired = (a: AttemptRecord) => a.status === "in_progress" && a.expiresAt !== null && now().getTime() > a.expiresAt.getTime() + DEADLINE_GRACE_MS;

  /* --------------------------------------- generation --------------------------------------- */

  async function startGeneration(userId: string, config: GenerationConfig, quizInput: Parameters<QuizRepository["createQuiz"]>[0], avoid: string[]): Promise<Quiz> {
    await repo.failStaleGenerating(userId, new Date(now().getTime() - STALE_AFTER_MS), [...running.keys()]);
    const busy = await repo.findGenerating(userId);
    if (busy) throw new AppError(409, "generation_in_progress", "A quiz is already being created. Wait for it to finish first.", { quizId: busy.id });

    const quiz = await repo.createQuiz(quizInput);
    const job = (async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), deps.jobDeadlineMs ?? JOB_DEADLINE_MS);
      try {
        const out = await generateQuestions({ ai, notes, rng, signal: controller.signal, onProgress: (p) => progress.set(quiz.id, p) }, userId, config, avoid);
        progress.set(quiz.id, { stage: "finalizing", batch: 0, accepted: out.questions.length, target: out.questions.length });
        const ok = await repo.completeGeneration(userId, quiz.id, out.questions, { provider: out.provider, model: out.model, isMock: out.isMock });
        if (!ok) onError(new Error("quiz was no longer generating when its questions were ready"));
      } catch (e) {
        const known = e instanceof QuizGenerationError;
        if (!known) onError(e);
        await repo
          .failGeneration(userId, quiz.id, known ? e.message : "Something went wrong while creating the quiz. Please try again.", {
            provider: ai.name,
            model: ai.model,
            isMock: ai.isMock,
          })
          .catch(onError);
      } finally {
        clearTimeout(deadline);
        running.delete(quiz.id);
        progress.delete(quiz.id);
      }
    })();
    running.set(quiz.id, job);
    return quiz;
  }

  async function resolveNotes(userId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const docs = [];
    for (const id of unique) {
      const doc = await notes.getNote(userId, id); // RLS + user filter: another student's note is simply "not found"
      if (!doc) throw new NotFoundError("One of the selected notes was not found.");
      if (doc.status !== "ready") throw new BadRequestError(`"${doc.title}" isn't ready yet. Wait until it finishes processing.`);
      docs.push(doc);
    }
    return docs;
  }

  const titleFor = (labels: string[]) => `${labels[0]}${labels.length > 1 ? ` +${labels.length - 1} more` : ""} quiz`.slice(0, 200);

  /* ------------------------------------------ attempts ------------------------------------------ */

  async function playQuestionsInOrder(userId: string, attempt: AttemptRecord): Promise<PlayQuestion[]> {
    const all = await repo.listPlayQuestions(userId, attempt.quizId);
    const byId = new Map(all.map((q) => [q.id, q]));
    return attempt.questionOrder.map((id) => byId.get(id)).filter((q): q is PlayQuestion => q !== undefined);
  }

  async function view(userId: string, attempt: AttemptRecord): Promise<AttemptView> {
    const quiz = await repo.getQuiz(userId, attempt.quizId);
    if (!quiz) throw new NotFoundError("Quiz not found.");
    const [questions, answers] = await Promise.all([playQuestionsInOrder(userId, attempt), repo.getAnswers(userId, attempt.id)]);
    return {
      attempt: {
        id: attempt.id,
        quizId: attempt.quizId,
        status: attempt.status,
        startedAt: attempt.startedAt.toISOString(),
        expiresAt: attempt.expiresAt?.toISOString() ?? null,
        submittedAt: attempt.submittedAt?.toISOString() ?? null,
      },
      quiz: { id: quiz.id, title: quiz.title, timeLimitMinutes: quiz.timeLimitMinutes, isMock: quiz.isMock, model: quiz.model },
      questions,
      answers: Object.fromEntries(answers),
      serverNow: now().toISOString(),
    };
  }

  /** Loads an attempt the student owns (anyone else's is "not found") and closes it if its deadline passed. */
  async function loadAttempt(userId: string, attemptId: string): Promise<AttemptRecord> {
    const attempt = await repo.getAttempt(userId, attemptId);
    if (!attempt) throw new NotFoundError("Attempt not found.");
    if (expired(attempt)) {
      await finalize(userId, attempt, true);
      return (await repo.getAttempt(userId, attemptId)) ?? attempt;
    }
    return attempt;
  }

  /** Grades the saved answers on the server and closes the attempt. Safe to call twice: the second call changes nothing. */
  async function finalize(userId: string, attempt: AttemptRecord, timedOut: boolean): Promise<void> {
    const [questions, answers] = await Promise.all([repo.getFullQuestions(userId, attempt.quizId), repo.getAnswers(userId, attempt.id)]);
    const graded = gradeAnswers(questions.map((q) => ({ id: q.id, correctIndex: q.correctIndex, topic: q.topic })), answers);
    const at = now();
    // A late attempt is closed at its deadline, so the time taken never exceeds the allowance.
    const end = timedOut && attempt.expiresAt ? attempt.expiresAt : at;
    await repo.finalizeAttempt(userId, attempt.id, {
      status: timedOut ? "expired" : "submitted",
      submittedAt: at,
      score: graded.correct,
      total: graded.total,
      percentage: graded.percentage,
      timeTakenSeconds: Math.max(0, Math.round((end.getTime() - attempt.startedAt.getTime()) / 1000)),
      graded: [...graded.correctness].map(([questionId, isCorrect]) => ({ questionId, isCorrect })),
    });
  }

  /** Checks that every answer is for a question of THIS attempt and a real option. */
  async function checkAnswers(userId: string, attempt: AttemptRecord, answers: SaveAnswersInput["answers"]) {
    const questions = await playQuestionsInOrder(userId, attempt);
    const byId = new Map(questions.map((q) => [q.id, q]));
    for (const a of answers) {
      const q = byId.get(a.questionId);
      if (!q) throw new BadRequestError("An answer refers to a question that isn't part of this quiz.");
      if (a.selected !== null && a.selected >= q.options.length) throw new BadRequestError("An answer refers to an option that doesn't exist.");
    }
  }

  async function createAttempt(userId: string, quizId: string, shuffle: boolean): Promise<AttemptView> {
    const quiz = await repo.getQuiz(userId, quizId);
    if (!quiz) throw new NotFoundError("Quiz not found.");
    if (quiz.status !== "ready") throw new ConflictError(quiz.status === "generating" ? "This quiz is still being created." : "This quiz couldn't be created. Generate it again.");

    // One open attempt per quiz: starting again simply resumes it.
    const open = await repo.findOpenAttempt(userId, quizId);
    if (open) {
      const current = await loadAttempt(userId, open.id); // closes it first if its deadline already passed
      if (current.status === "in_progress") return view(userId, current);
    }

    const questions = await repo.listPlayQuestions(userId, quizId);
    const ids = questions.map((q) => q.id);
    const startedAt = now();
    const expiresAt = quiz.timeLimitMinutes ? new Date(startedAt.getTime() + quiz.timeLimitMinutes * 60_000) : null;
    try {
      const attempt = await repo.createAttempt(userId, quizId, shuffle ? shuffled(ids, rng) : ids, expiresAt);
      return view(userId, attempt);
    } catch (e) {
      // Two simultaneous requests: the unique "one open attempt" index let only one through.
      const raced = await repo.findOpenAttempt(userId, quizId);
      if (raced) return view(userId, raced);
      throw e;
    }
  }

  const reviewSourceTitle = (quiz: Quiz, documentId: string) => quiz.sources.find((s) => s.id === documentId)?.title ?? null;

  async function buildResult(userId: string, attempt: AttemptRecord): Promise<QuizResult> {
    const quiz = await repo.getQuiz(userId, attempt.quizId);
    if (!quiz) throw new NotFoundError("Quiz not found.");
    const [questions, answers] = await Promise.all([repo.getFullQuestions(userId, attempt.quizId), repo.getAnswers(userId, attempt.id)]);
    const byId = new Map<string, StoredQuestion>(questions.map((q) => [q.id, q]));
    const graded = gradeAnswers(questions.map((q) => ({ id: q.id, correctIndex: q.correctIndex, topic: q.topic })), answers);
    const ordered = attempt.questionOrder.map((id) => byId.get(id)).filter((q): q is StoredQuestion => q !== undefined);

    const review: ReviewItem[] = ordered.map((q, i) => ({
      id: q.id,
      order: i,
      type: q.type,
      text: q.text,
      options: q.options,
      selected: answers.get(q.id) ?? null,
      correctAnswer: q.correctIndex,
      isCorrect: graded.correctness.get(q.id) === true,
      explanation: q.explanation,
      topic: q.topic,
      difficulty: q.difficulty,
      source: q.sourceRef
        ? { documentId: q.sourceRef.documentId, title: reviewSourceTitle(quiz, q.sourceRef.documentId), page: q.sourceRef.page, heading: q.sourceRef.heading, evidence: q.sourceRef.evidence ?? null }
        : null,
    }));

    return {
      attempt: {
        id: attempt.id,
        quizId: attempt.quizId,
        status: attempt.status,
        startedAt: attempt.startedAt.toISOString(),
        expiresAt: attempt.expiresAt?.toISOString() ?? null,
        submittedAt: attempt.submittedAt?.toISOString() ?? null,
        // The stored, server-calculated numbers - never anything the browser sent.
        score: attempt.score ?? graded.correct,
        total: attempt.total ?? graded.total,
        percentage: attempt.percentage ?? graded.percentage,
        correct: graded.correct,
        incorrect: graded.incorrect,
        unanswered: graded.unanswered,
        timeTakenSeconds: attempt.timeTakenSeconds,
        timedOut: attempt.status === "expired",
      },
      quiz,
      review,
      topics: topicPerformance(ordered.map((q) => ({ topic: q.topic, isCorrect: graded.correctness.get(q.id) === true }))),
    };
  }

  /* ------------------------------------------ public API ------------------------------------------ */

  return {
    /** Resolves when no generation job is running (used by tests and graceful shutdown). */
    async whenIdle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },

    async options(userId: string): Promise<QuizOptions> {
      const [ready, topics] = await Promise.all([notes.listNotes(userId, { sort: "activity", limit: 100 }), repo.topicSuggestions(userId, 12)]);
      return {
        notes: ready.filter((n) => n.status === "ready" && n.chunkCount > 0).map((n) => ({ id: n.id, title: n.title, chunkCount: n.chunkCount, pageCount: n.pageCount })),
        topics,
      };
    },

    async generate(userId: string, input: GenerateQuizInput): Promise<Quiz> {
      const types = input.questionTypes;
      if (input.source.type === "notes") {
        const docs = await resolveNotes(userId, input.source.documentIds);
        const focus = input.source.focus || null;
        return startGeneration(
          userId,
          { sourceType: "notes", subject: null, topic: null, focus, difficulty: input.difficulty, count: input.count, types, documentIds: docs.map((d) => d.id) },
          {
            userId,
            title: titleFor(docs.map((d) => d.title)),
            sourceType: "notes",
            subject: null,
            topic: null,
            focus,
            difficulty: input.difficulty,
            questionCount: input.count,
            questionTypes: types,
            timeLimitMinutes: input.timeLimitMinutes,
            documentIds: docs.map((d) => d.id),
          },
          [],
        );
      }
      const subject = input.source.subject;
      const topic = input.source.topic || null;
      return startGeneration(
        userId,
        { sourceType: "topic", subject, topic, focus: null, difficulty: input.difficulty, count: input.count, types, documentIds: [] },
        {
          userId,
          title: titleFor([topic ?? subject]),
          sourceType: "topic",
          subject,
          topic,
          focus: null,
          difficulty: input.difficulty,
          questionCount: input.count,
          questionTypes: types,
          timeLimitMinutes: input.timeLimitMinutes,
          documentIds: [],
        },
        [],
      );
    },

    /** A fresh quiz with the same settings and sources, told to avoid the questions of the original. */
    async regenerate(userId: string, quizId: string): Promise<Quiz> {
      const config = await repo.getQuizConfig(userId, quizId);
      if (!config) throw new NotFoundError("Quiz not found.");
      const previous = (await repo.getFullQuestions(userId, quizId)).map((q) => q.text).slice(-AVOID_LIMIT);
      const types = config.questionTypes.filter((t): t is "mcq" | "true_false" => t === "mcq" || t === "true_false");
      if (config.sourceType === "notes") await resolveNotes(userId, config.documentIds); // still exist and ready?
      return startGeneration(
        userId,
        { sourceType: config.sourceType, subject: config.subject, topic: config.topic, focus: config.focus, difficulty: config.difficulty, count: config.questionCount, types, documentIds: config.documentIds },
        { ...config, title: config.title.replace(/ \(new questions\)$/, "").slice(0, 180) + " (new questions)" },
        previous,
      );
    },

    async list(userId: string): Promise<{ quizzes: Quiz[]; summary: QuizSummary }> {
      let [quizzes, summary] = await Promise.all([repo.listQuizzes(userId, LIST_LIMIT), repo.summary(userId)]);
      if (await reapStale(userId, quizzes)) quizzes = await repo.listQuizzes(userId, LIST_LIMIT);
      return { quizzes: quizzes.map(withProgress), summary };
    },

    async detail(userId: string, quizId: string): Promise<QuizDetailResponse> {
      let quiz = await repo.getQuiz(userId, quizId);
      if (!quiz) throw new NotFoundError("Quiz not found.");
      if (await reapStale(userId, [quiz])) quiz = (await repo.getQuiz(userId, quizId)) ?? quiz;
      // While the quiz is still being written there are no questions or attempts to load: the poll stays one cheap query.
      if (quiz.status === "generating") return { quiz: withProgress(quiz), questions: [], attempts: [] };
      const [questions, attempts] = await Promise.all([quiz.status === "ready" ? repo.listPlayQuestions(userId, quizId) : Promise.resolve([]), repo.listAttemptsForQuiz(userId, quizId)]);
      return {
        quiz,
        questions,
        attempts: attempts.map((a) => ({
          id: a.id,
          quizId: a.quizId,
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          expiresAt: a.expiresAt?.toISOString() ?? null,
          submittedAt: a.submittedAt?.toISOString() ?? null,
          score: a.score,
          total: a.total,
          percentage: a.percentage,
        })),
      };
    },

    /** Starts the first attempt (questions in their natural order) or resumes the open one. */
    async start(userId: string, quizId: string): Promise<AttemptView> {
      const past = (await repo.listAttemptsForQuiz(userId, quizId)).length;
      return createAttempt(userId, quizId, past > 0);
    },

    /** A new attempt with the questions in a new order. Earlier attempts are untouched. */
    async retry(userId: string, quizId: string): Promise<AttemptView> {
      return createAttempt(userId, quizId, true);
    },

    async attemptView(userId: string, attemptId: string): Promise<AttemptView> {
      return view(userId, await loadAttempt(userId, attemptId));
    },

    async saveAnswers(userId: string, attemptId: string, input: SaveAnswersInput): Promise<{ saved: number }> {
      const attempt = await loadAttempt(userId, attemptId);
      if (attempt.status === "expired") throw err(410, "attempt_expired", "Time is up for this attempt. Your saved answers were submitted.");
      if (attempt.status !== "in_progress") throw new ConflictError("This attempt has already been submitted.");
      await checkAnswers(userId, attempt, input.answers);
      const ok = await repo.saveAnswers(userId, attemptId, input.answers, now());
      if (!ok) throw new ConflictError("This attempt has already been submitted.");
      return { saved: input.answers.length };
    },

    /** Grades on the server. Submitting twice returns the same stored result and changes nothing. */
    async submit(userId: string, attemptId: string, input: SubmitAttemptInput): Promise<QuizResult> {
      let attempt = await loadAttempt(userId, attemptId); // closes an overdue attempt as "expired" first
      if (attempt.status === "in_progress") {
        if (input.answers && input.answers.length > 0) {
          await checkAnswers(userId, attempt, input.answers);
          await repo.saveAnswers(userId, attemptId, input.answers, now());
        }
        await finalize(userId, attempt, false);
        attempt = (await repo.getAttempt(userId, attemptId)) ?? attempt;
      }
      return buildResult(userId, attempt);
    },

    async result(userId: string, attemptId: string): Promise<QuizResult> {
      const attempt = await loadAttempt(userId, attemptId);
      if (attempt.status === "in_progress") throw err(409, "not_submitted", "Submit the quiz to see your results.");
      return buildResult(userId, attempt);
    },

    async history(userId: string): Promise<AttemptHistoryItem[]> {
      return repo.listAttemptHistory(userId, HISTORY_LIMIT);
    },
  };
}

export type QuizService = ReturnType<typeof createQuizService>;
export { roundPercent };
