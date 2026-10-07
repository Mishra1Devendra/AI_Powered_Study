/**
 * Turns the model's untrusted JSON into a question or an evaluation we are willing to store and show. Anything that
 * does not fit is rejected as a whole (never half-saved); unknown fields are ignored and every string is cleaned and
 * length-limited. The caller may ask the model again ONCE (see ai.ts) - never more.
 */

export class VivaInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VivaInvalid";
  }
}

export interface ValidQuestion {
  question: string;
  concept: string;
  keyPoints: string[];
}

export interface ValidEvaluation {
  correctness: number;
  completeness: number;
  clarity: number;
  confidence: number;
  feedback: string;
  missingConcepts: string[];
  shouldFollowUp: boolean;
}

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** How alike two questions are (0-1), by shared words. */
function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(x.size, y.size);
}

/** Two questions this alike are treated as the same question. */
const DUPLICATE_AT = 0.75;

export function validateQuestion(raw: unknown, asked: ReadonlyArray<{ text: string }>): ValidQuestion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VivaInvalid("not an object");
  const r = raw as Record<string, unknown>;
  const question = clean(r.question, 400);
  if (question.length < 15) throw new VivaInvalid("question missing or too short");
  const concept = clean(r.concept, 60);
  if (concept.length < 2) throw new VivaInvalid("concept missing");
  const rawPoints = Array.isArray(r.keyPoints) ? r.keyPoints : [];
  const keyPoints = [...new Set(rawPoints.map((p) => clean(p, 160)).filter((p) => p.length >= 3))].slice(0, 5);
  if (keyPoints.length < 1) throw new VivaInvalid("key points missing");
  if (asked.some((q) => similarity(q.text, question) >= DUPLICATE_AT)) throw new VivaInvalid("repeats an earlier question");
  return { question, concept, keyPoints };
}

/** A score must be a number from 0 to 10 (a numeric string is accepted); decimals are rounded; anything else rejects the answer. */
function score10(v: unknown, name: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new VivaInvalid(`${name} is not a number`);
  if (n < 0 || n > 10) throw new VivaInvalid(`${name} is outside 0-10`);
  return Math.round(n);
}

export function validateEvaluation(raw: unknown): ValidEvaluation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new VivaInvalid("not an object");
  const r = raw as Record<string, unknown>;
  const feedback = clean(r.feedback, 1500);
  if (feedback.length < 10) throw new VivaInvalid("feedback missing or too short");
  const missing = Array.isArray(r.missingConcepts) ? r.missingConcepts : [];
  const seen = new Set<string>();
  const missingConcepts: string[] = [];
  for (const m of missing) {
    const c = clean(m, 80);
    const key = c.toLowerCase();
    if (c.length >= 2 && !seen.has(key)) {
      seen.add(key);
      missingConcepts.push(c);
    }
  }
  const follow = r.shouldFollowUp;
  return {
    correctness: score10(r.correctness, "correctness"),
    completeness: score10(r.completeness, "completeness"),
    clarity: score10(r.clarity, "clarity"),
    confidence: score10(r.confidence, "confidence"),
    feedback,
    missingConcepts: missingConcepts.slice(0, 5),
    shouldFollowUp: follow === true || follow === "true",
  };
}
