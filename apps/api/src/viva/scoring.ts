import { DIMENSIONS, DIMENSION_LABEL, PROGRESS_THRESHOLDS, scoreLevel, type Dimension, type VivaResult } from "@copilot/shared";

/**
 * Turns a finished viva's answers into the results page. Everything comes from the answers themselves: the strong and
 * weak areas are the concepts of questions that scored high or low, and the "missing concepts" the evaluations named.
 * Nothing is invented. The formula (see SCORE_WEIGHTS) is a simple documented weighting, not a validated measure.
 */

export interface AnsweredQuestion {
  number: number;
  concept: string;
  correctness: number;
  completeness: number;
  clarity: number;
  confidence: number;
  /** 0-100 */
  score: number;
  missingConcepts: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (list: readonly number[]) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0);
const norm = (s: string) => s.trim().toLowerCase();

const STRONG_AT = PROGRESS_THRESHOLDS.strongAtOrAbove;
const WEAK_BELOW = PROGRESS_THRESHOLDS.weakBelow;
const MAX_LIST = 5;

/** The viva score: the mean of the answer scores. */
export const overallScore = (scores: readonly number[]) => round1(mean(scores));

export function buildResult(answered: readonly AnsweredQuestion[]): VivaResult {
  const overall = overallScore(answered.map((a) => a.score));
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, round1(mean(answered.map((a) => a[d])) * 10)])) as Record<Dimension, number>;

  // Strong: concepts of answers at or above the strong line (best first, one per concept).
  const strong: string[] = [];
  for (const a of [...answered].sort((x, y) => y.score - x.score || x.number - y.number)) {
    if (a.score >= STRONG_AT && !strong.some((s) => norm(s) === norm(a.concept))) strong.push(a.concept);
  }

  // Missing concepts the evaluations named, most often named first.
  const counts = new Map<string, { name: string; n: number; first: number }>();
  answered.forEach((a, i) => {
    for (const m of a.missingConcepts) {
      const k = norm(m);
      const e = counts.get(k);
      counts.set(k, e ? { ...e, n: e.n + 1 } : { name: m, n: 1, first: i });
    }
  });
  const missing = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((m) => m.name);

  // Low-scoring concepts (weakest first).
  const low = [...answered].filter((a) => a.score < WEAK_BELOW).sort((x, y) => x.score - y.score || x.number - y.number);
  const lowConcepts = low.reduce<string[]>((acc, a) => (acc.some((c) => norm(c) === norm(a.concept)) ? acc : [...acc, a.concept]), []);

  const improve: string[] = [];
  for (const a of low.slice(0, 3)) improve.push(`Review ${a.concept} (${Math.round(a.score)}%)`);
  for (const m of missing.slice(0, 4)) improve.push(`Cover "${m}" in your explanations`);
  const lowest = [...DIMENSIONS].sort((a, b) => dims[a] - dims[b])[0]!;
  if (answered.length > 0 && dims[lowest] < 60) improve.push(`${DIMENSION_LABEL[lowest]} was your lowest area (${Math.round(dims[lowest])}%)`);

  const weak = [...lowConcepts];
  for (const m of missing) if (!weak.some((c) => norm(c) === norm(m))) weak.push(m);

  return {
    overall,
    level: scoreLevel(overall),
    dimensions: dims,
    strongAreas: strong.slice(0, MAX_LIST),
    improveAreas: improve.slice(0, 6),
    weakConcepts: weak.slice(0, MAX_LIST),
  };
}
