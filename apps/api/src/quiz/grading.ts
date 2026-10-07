import type { TopicPerformance } from "@copilot/shared";

/** Grading is done here, on the server, from the stored answer key. The browser never computes a score. */

export interface GradableQuestion {
  id: string;
  correctIndex: number;
  topic: string | null;
}

export interface Graded {
  /** question id -> true/false for answered questions; absent for unanswered ones. */
  correctness: Map<string, boolean>;
  correct: number;
  incorrect: number;
  unanswered: number;
  total: number;
  /** 0-100, two decimals. Unanswered questions count as not correct. */
  percentage: number;
}

export const roundPercent = (value: number) => Math.round(value * 100) / 100;

export function gradeAnswers(questions: readonly GradableQuestion[], selected: ReadonlyMap<string, number>): Graded {
  const correctness = new Map<string, boolean>();
  let correct = 0;
  let incorrect = 0;
  for (const q of questions) {
    const choice = selected.get(q.id);
    if (choice === undefined) continue;
    const ok = choice === q.correctIndex;
    correctness.set(q.id, ok);
    if (ok) correct++;
    else incorrect++;
  }
  const total = questions.length;
  return { correctness, correct, incorrect, unanswered: total - correct - incorrect, total, percentage: total === 0 ? 0 : roundPercent((correct / total) * 100) };
}

/**
 * Accuracy per topic from real graded questions. Unanswered questions count as not correct (the
 * student did not demonstrate them). Questions without a reliably known topic are grouped under
 * `topic: null` rather than given a made-up label. Weakest first.
 */
export function topicPerformance(rows: readonly { topic: string | null; isCorrect: boolean }[]): TopicPerformance[] {
  const by = new Map<string | null, { correct: number; total: number }>();
  for (const r of rows) {
    const entry = by.get(r.topic) ?? { correct: 0, total: 0 };
    entry.total++;
    if (r.isCorrect) entry.correct++;
    by.set(r.topic, entry);
  }
  return [...by.entries()]
    .map(([topic, v]) => ({ topic, correct: v.correct, total: v.total, percentage: roundPercent((v.correct / v.total) * 100) }))
    .sort((a, b) => (a.topic === null ? 1 : 0) - (b.topic === null ? 1 : 0) || a.percentage - b.percentage || b.total - a.total || (a.topic ?? "").localeCompare(b.topic ?? ""));
}
