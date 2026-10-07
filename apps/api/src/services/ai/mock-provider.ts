import { ANSWER_FENCE } from "./viva/prompt.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "./types.js";

export const MOCK_BANNER = "[DEMO AI - mock provider, not a real model]";

/**
 * Zero-cost stand-in. Output is deliberately and visibly fake so it can never be mistaken for
 * real tutoring. It echoes a little of what it received (message, earlier-message count, tutor
 * mode) so the full request path - history, mode, context - can be exercised without any model.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock" as const;
  readonly model = "mock-demo";
  readonly isMock = true;

  /**
   * @param chunkDelayMs pause between streamed chunks (0 in tests)
   * @param note why the mock is answering instead of a real model, shown to the student
   */
  constructor(
    private readonly chunkDelayMs = 12,
    private readonly note: string | null = null,
  ) {}

  /**
   * Offline demo quiz: valid JSON in the same shape a real model is asked for, with questions that
   * say plainly they are samples. Lets the whole quiz flow (generation, validation, taking, grading)
   * be exercised with no model running. The quiz is stored as is_mock and shown as MOCK AI.
   */
  private composeQuiz(spec: { want?: Record<string, number>; difficulty?: string; topics?: string[]; subject?: string | null; offset?: number; grounded?: boolean }): string {
    const questions: unknown[] = [];
    let n = spec.offset ?? 0;
    const levels = ["easy", "medium", "hard"];
    const difficulty = () => (spec.difficulty && spec.difficulty !== "mixed" ? spec.difficulty : levels[n % 3]);
    const about = spec.subject ? ` about ${spec.subject}` : "";
    // Distinct reference tokens keep every demo question different from the others (the validator rejects near-duplicates).
    const tokens = (i: number) => Array.from({ length: 6 }, (_, k) => `w${i}x${k}`).join(" ");
    const base = () => ({
      topic: spec.topics?.length ? spec.topics[n % spec.topics.length] : undefined,
      difficulty: difficulty(),
      ...(spec.grounded ? { source: "S1" } : {}),
    });
    for (let i = 0; i < (spec.want?.mcq ?? 0); i++, n++) {
      questions.push({
        type: "mcq",
        question: `[Demo] Placeholder, not real content, reference ${tokens(n)}${about}: which option is marked correct?`,
        options: ["Demo choice alpha", "Demo choice bravo", "Demo choice charlie", "Demo choice delta"],
        correctAnswer: n % 4,
        explanation: "Demo only: the choice marked correct for this placeholder question is a fixed sample, so it teaches nothing.",
        ...base(),
      });
    }
    for (let i = 0; i < (spec.want?.true_false ?? 0); i++, n++) {
      questions.push({
        type: "true_false",
        question: `[Demo] Sample true/false statement${about}, reference ${tokens(n)}: this statement is marked ${n % 2 === 0 ? "true" : "false"} (placeholder, not real content)`,
        correctAnswer: n % 2 === 0,
        explanation: "Demo only: this placeholder statement is marked true or false by a fixed rule, so it teaches nothing.",
        ...base(),
      });
    }
    return JSON.stringify({ questions });
  }

  /**
   * Offline demo study-plan topics: the student's own topics where given, otherwise clearly-marked
   * placeholder topics. The app schedules them as usual, and the plan is stored and shown as MOCK AI.
   */
  private composePlan(spec: { subjects?: Array<{ name: string; topics?: string[] }>; minutesPerDay?: number }): string {
    const minutes = Math.min(45, Math.max(15, spec.minutesPerDay ?? 45));
    return JSON.stringify({
      summary: "[Demo] Placeholder topics from the offline demo provider, not a real AI. Start your local AI for a real plan.",
      subjects: (spec.subjects ?? []).map((s) => ({
        subject: s.name,
        topics: (s.topics?.length ? s.topics : ["Core ideas (demo)", "Key terms (demo)", "Practice problems (demo)"]).map((topic) => ({ topic, minutes })),
      })),
    });
  }

  /**
   * Offline demo viva question: a clearly-marked placeholder, different for every question number (so the
   * duplicate check passes), with demo key points. The viva is stored and shown as MOCK AI.
   */
  private composeVivaQuestion(spec: { subject?: string; topic?: string | null; number?: number; followUp?: boolean }): string {
    const n = spec.number ?? 1;
    const about = [spec.subject, spec.topic].filter(Boolean).join(" - ") || "the subject";
    // Distinct reference words keep every demo question clearly different from the others (the repeat check rejects near-duplicates).
    const ref = Array.from({ length: 6 }, (_, k) => `v${n}x${k}`).join(" ");
    return JSON.stringify({
      question: spec.followUp
        ? `[Demo] Placeholder follow-up question ${n} about ${about}: can you explain why, and give one example? Reference ${ref}.`
        : `[Demo] Placeholder question ${n} about ${about}: explain demo idea ${n} in your own words. Reference ${ref}.`,
      concept: `Demo concept ${n}`,
      keyPoints: ["Core idea (demo)", "Key terms (demo)"],
    });
  }

  /**
   * Offline demo evaluation. Deterministic and deliberately crude (answer length and overlap with the demo key points),
   * so the whole viva flow can be exercised with no model. It is NOT a real evaluation and is always labelled as a demo.
   */
  private composeVivaEval(spec: { keyPoints?: string[] }, answer: string): string {
    const words = answer.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const set = new Set(words);
    const points = spec.keyPoints ?? [];
    const covered = points.filter((p) => (p.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some((w) => set.has(w)));
    const share = points.length ? covered.length / points.length : 0.5;
    const n = words.length;
    const clamp = (v: number) => Math.max(0, Math.min(10, Math.round(v)));
    const missing = points.filter((p) => !covered.includes(p)).slice(0, 3);
    return JSON.stringify({
      correctness: n === 0 ? 0 : clamp(3 + 6 * share),
      completeness: n === 0 ? 0 : clamp(2 + 6 * share + (n >= 30 ? 1 : 0)),
      clarity: n >= 30 ? 8 : n >= 10 ? 6 : n >= 3 ? 4 : 2,
      confidence: n >= 15 ? 6 : 4,
      feedback: "[Demo] This is canned demo feedback from the offline provider, not a real evaluation. Start your local AI for a real examiner.",
      missingConcepts: missing,
      shouldFollowUp: share < 0.5 && n >= 3,
    });
  }

  /**
   * Offline demo wording for the recommendations: one canned sentence per recommendation id, with no numbers or
   * invented facts. Shown as MOCK AI.
   */
  private composeReco(spec: { ids?: string[] }): string {
    return JSON.stringify({
      overview: "[Demo] This is canned demo text from the offline provider, not a real explanation. Your recommendations above come from your own learning data.",
      items: (spec.ids ?? []).map((id) => ({ id, text: "[Demo] A real local AI would explain here why this matters and what to do first." })),
    });
  }

  /** Offline demo flashcards: clearly marked placeholders, so a demo deck can never be mistaken for real study material. */
  private composeFlashcards(spec: { count?: number; subject?: string | null; topic?: string | null }): string {
    const about = [spec.subject, spec.topic].filter(Boolean).join(" - ") || "your notes";
    const n = Math.max(1, Math.min(30, spec.count ?? 8));
    return JSON.stringify({
      cards: Array.from({ length: n }, (_, i) => ({
        front: `[Demo] Placeholder question ${i + 1} about ${about}?`,
        back: `[Demo] Placeholder answer ${i + 1}. A real AI would write a short, accurate answer here.`,
        hint: "demo",
      })),
    });
  }

  /** Offline demo mind map: a small fixed tree around the requested title, every label marked as a demo. */
  private composeMindmap(spec: { title?: string; size?: string }): string {
    const branches = spec.size === "small" ? 3 : spec.size === "large" ? 6 : 4;
    return JSON.stringify({
      title: spec.title ?? "Demo mind map",
      root: {
        label: spec.title ?? "Demo mind map",
        children: Array.from({ length: branches }, (_, i) => ({
          label: `Demo branch ${i + 1}`,
          note: "[Demo] A real AI would explain this branch.",
          children: [{ label: `Demo point ${i + 1}.1` }, { label: `Demo point ${i + 1}.2` }],
        })),
      },
    });
  }

  private compose(request: GenerateTextRequest): string {
    const cardSpec = request.json ? /FLASHCARD_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (cardSpec) {
      try {
        return this.composeFlashcards(JSON.parse(cardSpec));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const mapSpec = request.json ? /MINDMAP_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (mapSpec) {
      try {
        return this.composeMindmap(JSON.parse(mapSpec));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const specLine = request.json ? /QUIZ_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (specLine) {
      try {
        return this.composeQuiz(JSON.parse(specLine));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const vivaQ = request.json ? /VIVA_QUESTION_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (vivaQ) {
      try {
        return this.composeVivaQuestion(JSON.parse(vivaQ));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const vivaE = request.json ? /VIVA_EVAL_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (vivaE) {
      try {
        const last = [...request.messages].reverse().find((m) => m.role === "user");
        return this.composeVivaEval(JSON.parse(vivaE), ANSWER_FENCE.exec(last?.content ?? "")?.[1] ?? "");
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const recoLine = request.json ? /RECO_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (recoLine) {
      try {
        return this.composeReco(JSON.parse(recoLine));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const planLine = request.json ? /PLAN_SPEC: ({.*})/.exec(request.system ?? "")?.[1] : undefined;
    if (planLine) {
      try {
        return this.composePlan(JSON.parse(planLine));
      } catch {
        /* fall through to the ordinary demo reply */
      }
    }
    const userMessages = request.messages.filter((m) => m.role === "user");
    const last = userMessages[userMessages.length - 1];
    const echoed = last ? last.content.slice(0, 120) : "(no message)";
    const mode = /Active tutor mode: (\w+)/.exec(request.system ?? "")?.[1];
    const earlier = Math.max(0, request.messages.length - 1);
    return [
      MOCK_BANNER,
      "",
      this.note ?? "No local AI model is running, so this is a canned demo reply.",
      `You asked: "${echoed}"`,
      "",
      `- Tutor mode seen by the provider: ${mode ?? "none"}`,
      `- Earlier messages in context: ${earlier}`,
    ].join("\n");
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    return { text: this.compose(request), provider: this.name, model: this.model, isMock: true };
  }

  async *streamText(request: GenerateTextRequest): TextStream {
    const text = this.compose(request);
    // Split into word-ish chunks, keeping whitespace/newlines so Markdown survives.
    for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted");
      if (this.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      yield chunk;
    }
    return { produced: { model: this.model, isMock: true } };
  }
}
