import type { AttemptHistoryItem, Quiz, QuizOptions, QuizResult, QuizSummary, QuestionDifficulty, ReviewItem } from "@copilot/shared";

/**
 * In-memory stand-in for the quiz API, used by tests and by the DEV-only /dev/quiz preview.
 * It behaves like the real server where it matters for the UI: the answer key stays inside this
 * module until an attempt is submitted, grading happens here, and a second submit returns the
 * stored result. Never bundled into production: its only non-test importer is the lazy, DEV-gated
 * preview page.
 */

export const qid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface FakeQuestion {
  id: string;
  quizId: string;
  order: number;
  type: "mcq" | "true_false";
  text: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  topic: string | null;
  difficulty: QuestionDifficulty;
  /** The sentence from the notes that supports the answer (notes quizzes only). */
  evidence: string | null;
}

interface FakeAttempt {
  id: string;
  quizId: string;
  status: "in_progress" | "submitted" | "expired";
  startedAt: string;
  expiresAt: string | null;
  submittedAt: string | null;
  order: string[];
  answers: Map<string, number>;
  score: number | null;
  total: number | null;
  percentage: number | null;
  timeTaken: number | null;
}

export interface QuizSeed {
  notes?: QuizOptions["notes"];
  topics?: QuizOptions["topics"];
  quizzes?: Quiz[];
  mock?: boolean;
}

const TOPICS = ["Mechanics", "Thermodynamics", "Waves"];
const BANK: Array<[string, string[], number, string]> = [
  ["Which law says energy cannot be created or destroyed?", ["The first law", "The second law", "Ohm's law", "Hooke's law"], 0, "The first law of thermodynamics is the statement of energy conservation."],
  ["Which quantity never decreases in an isolated system?", ["Temperature", "Entropy", "Pressure", "Volume"], 1, "The second law says the entropy of an isolated system does not decrease."],
  ["How does the Sun's heat reach the Earth?", ["Conduction", "Convection", "Radiation", "Insulation"], 2, "Radiation needs no medium, so it crosses empty space."],
  ["Which formula gives the Carnot efficiency?", ["1 - Tc/Th", "Th/Tc", "Tc - Th", "Q/W"], 0, "The Carnot efficiency is 1 minus the ratio of cold to hot reservoir temperatures."],
  ["What does a negative change in Gibbs free energy mean?", ["The process is spontaneous", "The process is impossible", "Heat is lost", "Entropy fell"], 0, "At constant T and P, a negative change in G marks a spontaneous process."],
  ["Which transfers heat through direct particle contact?", ["Radiation", "Convection", "Conduction", "Evaporation"], 2, "Conduction passes energy between touching particles."],
  ["What is the SI unit of force?", ["Joule", "Newton", "Watt", "Pascal"], 1, "Force is measured in newtons."],
  ["Which wave property is measured in hertz?", ["Amplitude", "Wavelength", "Frequency", "Speed"], 2, "Frequency counts cycles per second."],
];

export function makeBackend(seed: QuizSeed = {}) {
  let n = 1000;
  const now = () => new Date().toISOString();
  const quizzes: Quiz[] = [...(seed.quizzes ?? [])];
  const questions: FakeQuestion[] = [];
  const attempts: FakeAttempt[] = [];
  const calls: Call[] = [];
  const knobs = {
    networkDown: false,
    /** Quizzes stay "generating" until `finish(id)` is called. */
    holdGeneration: false,
    failGenerationWith: null as string | null,
    failSave: false,
    /** Shown on quizzes that are being held in "generating" (what the real server reports as it works). */
    progress: null as null | Quiz["progress"],
    failSubmitOnce: null as null | { status: number; message: string },
    /** Delay (ms) added to submit so tests can try a double click. */
    submitDelayMs: 0,
    /** Simulate the time limit running out on the next attempt fetch. */
    expireNow: false,
  };
  const options: QuizOptions = { notes: seed.notes ?? [], topics: seed.topics ?? [] };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const err = (status: number, error: string, message: string, extra: object = {}) => json({ error, message, ...extra }, status);

  function fill(quiz: Quiz, count: number, types: string[], difficulty: string) {
    for (let i = 0; i < count; i++) {
      const tf = types.includes("true_false") && (!types.includes("mcq") || i % 3 === 2);
      const [text, opts, correct, why] = BANK[(i + quizzes.length - 1) % BANK.length]!;
      const id = qid(++n);
      questions.push({
        id,
        quizId: quiz.id,
        order: i,
        type: tf ? "true_false" : "mcq",
        text: tf ? `${opts[correct]} is the right answer to: ${text}` : text,
        options: tf ? ["True", "False"] : opts,
        correctIndex: tf ? 0 : correct,
        explanation: why,
        topic: TOPICS[i % TOPICS.length]!,
        evidence: quiz.sourceType === "notes" ? `From the notes: ${why}` : null,
        difficulty: difficulty === "mixed" ? (["easy", "medium", "hard"] as const)[i % 3]! : (difficulty as QuestionDifficulty),
      });
    }
    quiz.status = "ready";
    quiz.isMock = seed.mock ?? true;
    quiz.model = seed.mock === false ? "llama3.2:3b" : "mock-demo";
  }

  const stats = (q: Quiz) => {
    const done = attempts.filter((a) => a.quizId === q.id && a.status !== "in_progress");
    q.attemptCount = done.length;
    q.bestPercentage = done.length ? Math.max(...done.map((a) => a.percentage ?? 0)) : null;
    q.inProgressAttemptId = attempts.find((a) => a.quizId === q.id && a.status === "in_progress")?.id ?? null;
    q.lastAttemptAt = done.map((a) => a.submittedAt).filter(Boolean).sort().pop() ?? null;
    return q;
  };

  const play = (qs: FakeQuestion[]) => qs.map((q) => ({ id: q.id, order: q.order, type: q.type, text: q.text, options: q.options, difficulty: q.difficulty, topic: q.topic }));
  const questionsOf = (quizId: string) => questions.filter((q) => q.quizId === quizId).sort((a, b) => a.order - b.order);

  function view(a: FakeAttempt) {
    const quiz = quizzes.find((q) => q.id === a.quizId)!;
    const byId = new Map(questionsOf(a.quizId).map((q) => [q.id, q]));
    return {
      attempt: { id: a.id, quizId: a.quizId, status: a.status, startedAt: a.startedAt, expiresAt: a.expiresAt, submittedAt: a.submittedAt },
      quiz: { id: quiz.id, title: quiz.title, timeLimitMinutes: quiz.timeLimitMinutes, isMock: quiz.isMock, model: quiz.model },
      questions: play(a.order.map((id) => byId.get(id)!)),
      answers: Object.fromEntries(a.answers),
      serverNow: now(),
    };
  }

  function grade(a: FakeAttempt, status: "submitted" | "expired") {
    const qs = questionsOf(a.quizId);
    const correct = qs.filter((q) => a.answers.get(q.id) === q.correctIndex).length;
    a.status = status;
    a.submittedAt = now();
    a.score = correct;
    a.total = qs.length;
    a.percentage = qs.length ? Math.round((correct / qs.length) * 10000) / 100 : 0;
    a.timeTaken = Math.max(1, Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000));
  }

  function result(a: FakeAttempt): QuizResult {
    const quiz = stats(quizzes.find((q) => q.id === a.quizId)!);
    const byId = new Map(questionsOf(a.quizId).map((q) => [q.id, q]));
    const ordered = a.order.map((id) => byId.get(id)!);
    const review: ReviewItem[] = ordered.map((q, i) => ({
      id: q.id,
      order: i,
      type: q.type,
      text: q.text,
      options: q.options,
      selected: a.answers.get(q.id) ?? null,
      correctAnswer: q.correctIndex,
      isCorrect: a.answers.get(q.id) === q.correctIndex,
      explanation: q.explanation,
      topic: q.topic,
      difficulty: q.difficulty,
      source: q.evidence ? { documentId: null, title: quiz.sources[0]?.title ?? null, page: q.order + 1, heading: q.topic, evidence: q.evidence } : null,
    }));
    const correct = review.filter((r) => r.isCorrect).length;
    const incorrect = review.filter((r) => !r.isCorrect && r.selected !== null).length;
    const topics = new Map<string | null, { correct: number; total: number }>();
    for (const r of review) {
      const t = topics.get(r.topic) ?? { correct: 0, total: 0 };
      t.total++;
      if (r.isCorrect) t.correct++;
      topics.set(r.topic, t);
    }
    return {
      attempt: {
        id: a.id,
        quizId: a.quizId,
        status: a.status,
        startedAt: a.startedAt,
        expiresAt: a.expiresAt,
        submittedAt: a.submittedAt,
        score: a.score!,
        total: a.total!,
        percentage: a.percentage!,
        correct,
        incorrect,
        unanswered: review.length - correct - incorrect,
        timeTakenSeconds: a.timeTaken,
        timedOut: a.status === "expired",
      },
      quiz,
      review,
      topics: [...topics].map(([topic, v]) => ({ topic, ...v, percentage: Math.round((v.correct / v.total) * 10000) / 100 })).sort((x, y) => x.percentage - y.percentage),
    };
  }

  function newAttempt(quizId: string, shuffle: boolean): FakeAttempt {
    const quiz = quizzes.find((q) => q.id === quizId)!;
    const ids = questionsOf(quizId).map((q) => q.id);
    const startedAt = now();
    const a: FakeAttempt = {
      id: qid(++n),
      quizId,
      status: "in_progress",
      startedAt,
      expiresAt: quiz.timeLimitMinutes ? new Date(Date.now() + quiz.timeLimitMinutes * 60_000).toISOString() : null,
      submittedAt: null,
      order: shuffle ? [...ids].reverse() : ids,
      answers: new Map(),
      score: null,
      total: null,
      percentage: null,
      timeTaken: null,
    };
    attempts.unshift(a);
    return a;
  }

  const summary = (): QuizSummary => {
    const done = attempts.filter((a) => a.status !== "in_progress");
    const pct = done.map((a) => a.percentage ?? 0);
    const topics = new Map<string | null, { correct: number; total: number }>();
    for (const a of done)
      for (const q of questionsOf(a.quizId)) {
        const t = topics.get(q.topic) ?? { correct: 0, total: 0 };
        t.total++;
        if (a.answers.get(q.id) === q.correctIndex) t.correct++;
        topics.set(q.topic, t);
      }
    return {
      quizzesCreated: quizzes.filter((q) => q.status === "ready").length,
      attemptsCompleted: done.length,
      averagePercentage: pct.length ? Math.round((pct.reduce((s, p) => s + p, 0) / pct.length) * 100) / 100 : null,
      bestPercentage: pct.length ? Math.max(...pct) : null,
      questionsAnswered: done.reduce((s, a) => s + a.answers.size, 0),
      topics: [...topics].map(([topic, v]) => ({ topic, ...v, percentage: Math.round((v.correct / v.total) * 10000) / 100 })).sort((x, y) => x.percentage - y.percentage),
    };
  };

  const history = (): AttemptHistoryItem[] =>
    attempts.map((a) => {
      const q = quizzes.find((x) => x.id === a.quizId)!;
      return { id: a.id, quizId: a.quizId, quizTitle: q.title, sourceType: q.sourceType, sourceLabel: q.sourceLabel, difficulty: q.difficulty, questionCount: q.questionCount, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, score: a.score, total: a.total, percentage: a.percentage };
    });

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (knobs.networkDown) throw new TypeError("Failed to fetch");

    if (url === "/api/health") {
      return json({ status: "ok", ai: { provider: seed.mock === false ? "ollama" : "mock", isMock: seed.mock ?? true, model: seed.mock === false ? "llama3.2:3b" : "mock-demo" } });
    }
    // The AI Tutor page loads its history when "Ask AI to explain" opens it.
    if (url.startsWith("/api/tutor/conversations") && method === "GET") return json({ conversations: [] });
    if (url === "/api/quiz/options") return json(options);
    if (url === "/api/quiz" && method === "GET") return json({ quizzes: quizzes.map(stats), summary: summary() });
    if (url === "/api/quiz/attempts" && method === "GET") return json({ attempts: history() });

    if (url === "/api/quiz/generate" && method === "POST") {
      const busy = quizzes.find((q) => q.status === "generating");
      if (busy) return err(409, "generation_in_progress", "A quiz is already being created. Wait for it to finish first.", { quizId: busy.id });
      const src = body!.source as { type: "notes" | "topic"; documentIds?: string[]; subject?: string; topic?: string };
      const titles = src.type === "notes" ? options.notes.filter((x) => src.documentIds?.includes(x.id)).map((x) => x.title) : [];
      const quiz: Quiz = {
        id: qid(++n),
        title: `${src.type === "notes" ? (titles[0] ?? "Notes") : (src.topic || src.subject)} quiz`,
        sourceType: src.type,
        sourceLabel: src.type === "notes" ? titles.join(", ") : [src.subject, src.topic].filter(Boolean).join(" · "),
        subject: src.subject ?? null,
        topic: src.topic ?? null,
        sources: src.type === "notes" ? (src.documentIds ?? []).map((id) => ({ id, title: titles[0] ?? "Notes" })) : [],
        difficulty: body!.difficulty as Quiz["difficulty"],
        questionCount: body!.count as number,
        questionTypes: body!.questionTypes as Quiz["questionTypes"],
        timeLimitMinutes: (body!.timeLimitMinutes as number | null) ?? null,
        status: "generating",
        error: null,
        isMock: false,
        model: null,
        createdAt: now(),
        attemptCount: 0,
        bestPercentage: null,
        lastAttemptAt: null,
        inProgressAttemptId: null,
      };
      quizzes.unshift(quiz);
      if (knobs.failGenerationWith) {
        quiz.status = "failed";
        quiz.error = knobs.failGenerationWith;
      } else if (!knobs.holdGeneration) fill(quiz, quiz.questionCount, quiz.questionTypes, quiz.difficulty);
      else quiz.progress = knobs.progress;
      return json({ quiz }, 202);
    }

    const m = /^\/api\/quiz\/(attempts\/)?([^/]+)(\/answers|\/submit|\/result|\/start|\/retry|\/regenerate)?$/.exec(url);
    if (!m) return err(500, "nope", `Unhandled ${method} ${url}`);
    const [, isAttempt, id, action] = m;

    if (isAttempt) {
      const a = attempts.find((x) => x.id === id);
      if (!a) return err(404, "not_found", "Attempt not found.");
      if (a.status === "in_progress" && knobs.expireNow) {
        knobs.expireNow = false;
        grade(a, "expired");
      }
      if (!action && method === "GET") return json(view(a));
      if (action === "/answers" && method === "PUT") {
        if (knobs.failSave) return err(503, "unavailable", "Could not save right now.");
        if (a.status !== "in_progress") return err(409, "conflict", "This attempt has already been submitted.");
        for (const x of (body!.answers as Array<{ questionId: string; selected: number | null }>) ?? []) {
          if (x.selected === null) a.answers.delete(x.questionId);
          else a.answers.set(x.questionId, x.selected);
        }
        return json({ saved: (body!.answers as unknown[]).length });
      }
      if (action === "/submit" && method === "POST") {
        if (knobs.failSubmitOnce) {
          const f = knobs.failSubmitOnce;
          knobs.failSubmitOnce = null;
          return err(f.status, "x", f.message);
        }
        if (knobs.submitDelayMs) await new Promise((r) => setTimeout(r, knobs.submitDelayMs));
        if (a.status === "in_progress") {
          for (const x of ((body?.answers as Array<{ questionId: string; selected: number }>) ?? [])) a.answers.set(x.questionId, x.selected);
          grade(a, "submitted");
        }
        return json(result(a));
      }
      if (action === "/result" && method === "GET") {
        if (a.status === "in_progress") return err(409, "not_submitted", "Submit the quiz to see your results.");
        return json(result(a));
      }
    }

    const quiz = quizzes.find((q) => q.id === id);
    if (!quiz) return err(404, "not_found", "Quiz not found.");
    if (!action && method === "GET") {
      return json({
        quiz: stats(quiz),
        questions: quiz.status === "ready" ? play(questionsOf(quiz.id)) : [],
        attempts: attempts.filter((a) => a.quizId === quiz.id).map((a) => ({ id: a.id, quizId: a.quizId, status: a.status, startedAt: a.startedAt, expiresAt: a.expiresAt, submittedAt: a.submittedAt, score: a.score, total: a.total, percentage: a.percentage })),
      });
    }
    if ((action === "/start" || action === "/retry") && method === "POST") {
      if (quiz.status !== "ready") return err(409, "conflict", "This quiz isn't ready.");
      const open = attempts.find((a) => a.quizId === quiz.id && a.status === "in_progress");
      return json(view(open ?? newAttempt(quiz.id, action === "/retry" || attempts.some((a) => a.quizId === quiz.id))));
    }
    if (action === "/regenerate" && method === "POST") {
      if (quizzes.some((q) => q.status === "generating")) return err(409, "generation_in_progress", "A quiz is already being created. Wait for it to finish first.");
      const copy: Quiz = { ...quiz, id: qid(++n), title: `${quiz.title} (new questions)`, status: "generating", createdAt: now(), attemptCount: 0, bestPercentage: null, lastAttemptAt: null, inProgressAttemptId: null };
      quizzes.unshift(copy);
      if (!knobs.holdGeneration) fill(copy, copy.questionCount, copy.questionTypes, copy.difficulty);
      return json({ quiz: copy }, 202);
    }
    return err(500, "nope", `Unhandled ${method} ${url}`);
  };

  return {
    fetchMock,
    calls,
    quizzes,
    attempts,
    knobs,
    /** The answer key, which only the "server" holds. Tests read it to answer correctly. */
    key: (quizId: string) => new Map(questionsOf(quizId).map((q) => [q.id, q])),
    /** Completes a quiz that was held in "generating". */
    finish(quizId: string) {
      const q = quizzes.find((x) => x.id === quizId)!;
      fill(q, q.questionCount, q.questionTypes, q.difficulty);
    },
    /** Adds a ready quiz with questions straight into the store. */
    addReadyQuiz(partial: Partial<Quiz> = {}): Quiz {
      const quiz: Quiz = {
        id: qid(++n),
        title: "Physics quiz",
        sourceType: "topic",
        sourceLabel: "Physics",
        subject: "Physics",
        topic: null,
        sources: [],
        difficulty: "medium",
        questionCount: 4,
        questionTypes: ["mcq"],
        timeLimitMinutes: null,
        status: "generating",
        error: null,
        isMock: true,
        model: "mock-demo",
        createdAt: now(),
        attemptCount: 0,
        bestPercentage: null,
        lastAttemptAt: null,
        inProgressAttemptId: null,
        ...partial,
      };
      quizzes.unshift(quiz);
      if (quiz.status === "generating") {
        fill(quiz, quiz.questionCount, quiz.questionTypes, quiz.difficulty);
        // fill() stamps the seed defaults; an explicit choice by the caller wins.
        if (partial.isMock !== undefined) quiz.isMock = partial.isMock;
        if (partial.model !== undefined) quiz.model = partial.model;
      }
      return quiz;
    },
  };
}
