import { answerScore, type CreateVivaRequest, type VivaDetail, type VivaOptions, type VivaQuestion, type VivaResult, type VivaSession } from "@copilot/shared";

/**
 * In-memory stand-in for the viva API, used by tests and by the DEV-only /dev/viva preview. It follows the real
 * server's rules where the UI depends on them: the examiner's key points stay hidden until a question is answered,
 * one answer per question, only the current question can be answered, the viva completes with the last answer and
 * its score is the mean of the answer scores, and a finished viva can no longer be changed. Never bundled into
 * production: its only non-test importer is the lazy, DEV-gated preview page.
 */

export const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface VivaCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

const BANK: Array<[string, string, string[]]> = [
  ["Why does increasing temperature generally increase the rate of a chemical reaction?", "Reaction rate", ["More energetic collisions", "Activation energy", "Collision frequency"]],
  ["What does a catalyst do to the energy barrier of a reaction, and why does that matter?", "Catalysts", ["Lowers activation energy", "Alternative pathway", "Not used up"]],
  ["How would doubling the concentration of a reactant change how often particles collide?", "Concentration", ["More particles per volume", "Higher collision frequency"]],
  ["Explain what the rate law tells you about an experiment's data.", "Rate laws", ["Order of reaction", "Rate constant"]],
  ["Why does grinding a solid into powder make it react faster with an acid?", "Surface area", ["More exposed surface", "More collisions"]],
];

interface Row {
  question: Omit<VivaQuestion, "keyPoints" | "answer">;
  keyPoints: string[];
  answer: VivaQuestion["answer"];
}
interface Viva {
  session: VivaSession;
  rows: Row[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, message: string, error = "error") => json(status, { error, message });

export function makeVivaBackend(opts: { mock?: boolean; topics?: VivaOptions["topics"]; documents?: NonNullable<VivaOptions["documents"]> } = {}) {
  const calls: VivaCall[] = [];
  const vivas: Viva[] = [];
  let n = 100;
  const knobs = { failNext: null as null | { status: number; message: string; error?: string }, delayMs: 0, mock: opts.mock ?? false };

  const toQuestion = (r: Row): VivaQuestion => ({ ...r.question, keyPoints: r.answer ? r.keyPoints : null, answer: r.answer });

  function result(v: Viva): VivaResult {
    const answered = v.rows.filter((r) => r.answer);
    const avg = (f: (a: NonNullable<Row["answer"]>) => number) => Math.round((answered.reduce((s, r) => s + f(r.answer!), 0) / answered.length) * 100) / 10;
    const strong = answered.filter((r) => r.answer!.score >= 75).map((r) => r.question.concept);
    const missing = [...new Set(answered.flatMap((r) => r.answer!.missingConcepts))];
    const low = answered.filter((r) => r.answer!.score < 50).map((r) => r.question.concept);
    return {
      overall: v.session.score ?? 0,
      level: (v.session.score ?? 0) >= 75 ? "strong" : (v.session.score ?? 0) < 50 ? "weak" : "developing",
      dimensions: { correctness: avg((a) => a.correctness), completeness: avg((a) => a.completeness), clarity: avg((a) => a.clarity), confidence: avg((a) => a.confidence) },
      strongAreas: strong.slice(0, 5),
      improveAreas: [...low.map((c) => `Review ${c}`), ...missing.slice(0, 3).map((m) => `Cover "${m}" in your explanations`)].slice(0, 6),
      weakConcepts: [...low, ...missing].slice(0, 5),
    };
  }

  const detail = (v: Viva): VivaDetail => ({
    session: { ...v.session, answeredCount: v.rows.filter((r) => r.answer).length },
    questions: v.rows.map(toQuestion),
    result: v.session.status === "completed" ? result(v) : null,
  });

  function questionRow(number: number, followUp: boolean): Row {
    const [text, concept, keyPoints] = BANK[(number - 1) % BANK.length]!;
    return {
      question: { id: vid(++n), number, text: knobs.mock ? `[Demo] Placeholder question ${number}: explain demo idea ${number} in your own words.` : followUp ? `Can you explain why, and give one example? (${text})` : text, concept: knobs.mock ? `Demo concept ${number}` : concept, isFollowUp: followUp },
      keyPoints,
      answer: null,
    };
  }

  /** A crude but deterministic evaluation: longer, more specific answers score higher. */
  function evaluate(answer: string, keyPoints: string[]) {
    const words: string[] = answer.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const covered = keyPoints.filter((k) => k.toLowerCase().split(/\W+/).some((w) => w.length > 4 && words.includes(w)));
    const share = covered.length / keyPoints.length;
    const clamp = (x: number) => Math.max(0, Math.min(10, Math.round(x)));
    const correctness = clamp(3 + 6 * share);
    const completeness = clamp(2 + 7 * share);
    const clarity = words.length >= 20 ? 8 : words.length >= 8 ? 6 : 3;
    const confidence = words.length >= 15 ? 7 : 4;
    return {
      correctness,
      completeness,
      clarity,
      confidence,
      score: answerScore({ correctness, completeness, clarity, confidence }),
      feedback: knobs.mock ? "[Demo] This is canned demo feedback, not a real evaluation." : "You explained part of the idea. Try to say why it happens, and add an example.",
      missingConcepts: keyPoints.filter((k) => !covered.includes(k)).slice(0, 2),
      shouldFollowUp: share < 0.5,
    };
  }

  async function fetchMock(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    if (path === "/api/health") return json(200, { status: "ok", ai: { provider: knobs.mock ? "mock" : "ollama", isMock: knobs.mock, model: knobs.mock ? "mock-demo" : "llama3.2:3b" } });
    if (knobs.delayMs) await new Promise((r) => setTimeout(r, knobs.delayMs));
    if (knobs.failNext) {
      const f = knobs.failNext;
      knobs.failNext = null;
      return fail(f.status, f.message, f.error);
    }
    if (path === "/api/viva/options" && method === "GET") return json(200, { topics: opts.topics ?? [], ...(opts.documents ? { documents: opts.documents } : {}) } satisfies VivaOptions);
    if (path === "/api/viva/sessions" && method === "GET") {
      const sessions = [...vivas].reverse().map((v) => detail(v).session);
      const done = sessions.filter((s) => s.status === "completed" && s.score !== null);
      return json(200, { sessions, summary: { completed: done.length, averageScore: done.length ? Math.round((done.reduce((s, x) => s + x.score!, 0) / done.length) * 10) / 10 : null } });
    }
    if (path === "/api/viva/sessions" && method === "POST") {
      const input = body as unknown as CreateVivaRequest;
      if (!input.subject?.trim()) return fail(400, "Enter a subject", "invalid_input");
      const sourceType = input.sourceType ?? "general";
      const doc = sourceType === "document" ? opts.documents?.find((d) => d.id === input.documentId) : undefined;
      if (sourceType === "document" && !doc) return fail(404, "Document not found.", "not_found");
      if (sourceType !== "general" && (opts.documents ?? []).length === 0) return fail(422, "I couldn't find relevant information in this material.", "no_material");
      const v: Viva = {
        session: { id: vid(++n), subject: input.subject.trim(), topic: input.topic?.trim() || null, difficulty: input.difficulty, questionCount: input.questionCount ?? 5, status: "in_progress", score: null, answeredCount: 0, isMock: knobs.mock, model: knobs.mock ? "mock-demo" : "llama3.2:3b", startedAt: new Date().toISOString(), completedAt: null, sourceType, documentId: doc?.id ?? null, documentTitle: doc?.title ?? null },
        rows: [],
      };
      v.rows.push(questionRow(1, false));
      vivas.push(v);
      return json(201, detail(v));
    }
    const m = /^\/api\/viva\/sessions\/([^/]+)(?:\/(answer|next|abandon))?$/.exec(path);
    if (!m) return fail(404, "Not found.");
    const v = vivas.find((x) => x.session.id === m[1]);
    if (!v) return fail(404, "Viva not found.");
    if (!m[2] && method === "GET") return json(200, detail(v));
    if (method !== "POST") return fail(404, "Not found.");
    const s = v.session;
    if (s.status !== "in_progress") return fail(409, s.status === "completed" ? "This viva is already completed." : "This viva was abandoned.", "conflict");
    const current = v.rows[v.rows.length - 1]!;
    if (m[2] === "abandon") {
      s.status = "abandoned";
      return json(200, detail(v));
    }
    if (m[2] === "answer") {
      const text = String(body?.answer ?? "").trim();
      if (!text) return fail(400, "Write an answer first", "invalid_input");
      if (text.length > 3000) return fail(400, "Answers can be at most 3000 characters.", "invalid_input");
      if (body?.questionId !== current.question.id) return fail(409, "That is not the current question.", "conflict");
      if (current.answer) return fail(409, "You already answered this question.", "already_answered");
      const e = evaluate(text, current.keyPoints);
      current.answer = { answerText: text, correctness: e.correctness, completeness: e.completeness, clarity: e.clarity, confidence: e.confidence, score: e.score, feedback: e.feedback, missingConcepts: e.missingConcepts, shouldFollowUp: e.shouldFollowUp, answeredAt: new Date().toISOString() };
      if (current.question.number >= s.questionCount) {
        const scores = v.rows.map((r) => r.answer!.score);
        Object.assign(s, { status: "completed", score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, completedAt: new Date().toISOString() });
      }
      return json(200, detail(v));
    }
    if (m[2] === "next") {
      if (!current.answer) return json(200, detail(v));
      const follow = current.answer.shouldFollowUp && !current.question.isFollowUp && current.answer.score < 75;
      v.rows.push(questionRow(v.rows.length + 1, follow));
      return json(200, detail(v));
    }
    return fail(404, "Not found.");
  }

  return {
    fetchMock,
    calls,
    vivas,
    knobs,
    /** Adds a ready-made completed viva (for the preview and history tests). */
    addCompleted(input: { subject: string; topic?: string; difficulty?: CreateVivaRequest["difficulty"]; questionCount?: number; scores: number[]; isMock?: boolean }): VivaDetail {
      const count = input.questionCount ?? input.scores.length;
      const rows: Row[] = input.scores.map((score, i) => {
        const r = questionRow(i + 1, false);
        const k = Math.round(score / 10);
        r.answer = { answerText: `A sample answer for question ${i + 1}.`, correctness: k, completeness: Math.max(0, k - 1), clarity: Math.min(10, k + 1), confidence: Math.max(0, k - 1), score, feedback: "Sample feedback for the preview.", missingConcepts: score < 75 ? [r.keyPoints[0]!] : [], shouldFollowUp: false, answeredAt: new Date().toISOString() };
        return r;
      });
      const mean = Math.round((input.scores.reduce((a, b) => a + b, 0) / input.scores.length) * 10) / 10;
      const v: Viva = {
        session: { id: vid(++n), subject: input.subject, topic: input.topic ?? null, difficulty: input.difficulty ?? "medium", questionCount: count, status: "completed", score: mean, answeredCount: input.scores.length, isMock: input.isMock ?? false, model: "llama3.2:3b", startedAt: new Date(Date.now() - 86_400_000).toISOString(), completedAt: new Date(Date.now() - 86_000_000).toISOString() },
        rows,
      };
      vivas.push(v);
      return detail(v);
    },
  };
}
