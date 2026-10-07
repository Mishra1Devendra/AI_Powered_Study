import type { Difficulty, GeneratableQuestionType, QuestionDifficulty } from "@copilot/shared";

/**
 * Everything the model returns is untrusted. This module turns its JSON into questions we are
 * willing to store, or rejects each question with a reason. Nothing malformed is ever saved.
 */

export const TRUE_FALSE_OPTIONS = ["True", "False"] as const;

export interface ValidQuestion {
  type: GeneratableQuestionType;
  text: string;
  /** Exactly 4 options for mcq; ["True", "False"] for true_false. */
  options: string[];
  /** Index into `options`. */
  correctIndex: number;
  explanation: string;
  /** Only a value from the allowed list; null when the model gave none (or something we cannot trust). */
  topic: string | null;
  difficulty: QuestionDifficulty;
  /** Which supplied passage the question says it came from ("S2"), if that key really exists. */
  sourceKey: string | null;
  /** A verbatim quote from the notes that the model says proves the answer (notes quizzes). Checked by quality.ts. */
  evidence: string | null;
}

export interface Rejection {
  index: number;
  reason: string;
  /** Kind of problem, for the "what went wrong" summary: "structure", "duplicate", or a quality code. */
  code: string;
}

export interface ValidationContext {
  /** How many more questions of each type we still accept (extras are rejected). */
  remaining: Partial<Record<GeneratableQuestionType, number>>;
  /** The quiz's requested difficulty. */
  difficulty: Difficulty;
  /** Topic labels a question may carry (matched case-insensitively). Empty = no topic labels at all. */
  allowedTopics: string[];
  /** Passage keys that were actually supplied to the model. */
  sourceKeys: string[];
  /** Questions already accepted or asked before; a near-copy of any of these is rejected. */
  existing: string[];
  /** Optional quality gate, run on each structurally valid question. Returns why it fails, or null. */
  quality?: (q: ValidQuestion) => { code: string; reason: string } | null;
}

const MIN_QUESTION = 12;
const MAX_EVIDENCE = 400;
const MAX_QUESTION = 500;
const MAX_OPTION = 200;
const MIN_EXPLANATION = 10;
const MAX_EXPLANATION = 800;
const DUPLICATE_SIMILARITY = 0.7;

/** Extracts the array of raw questions from the model's text, tolerating Markdown fences. Null = unusable. */
export function parseQuestionsJson(text: string): unknown[] | null {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced?.[1]) body = fenced[1];
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    // Some models wrap the JSON in a sentence. Take the outermost object.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return salvageQuestions(body);
    try {
      value = JSON.parse(body.slice(start, end + 1));
    } catch {
      // Still not valid: usually the reply was cut off at the output limit. Keep the questions that are complete.
      return salvageQuestions(body);
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { questions?: unknown }).questions)) {
    return (value as { questions: unknown[] }).questions;
  }
  return null;
}

/**
 * Recovers the COMPLETE question objects from a reply that is not valid JSON as a whole - typically one
 * cut off part-way through the last question. Every recovered object still goes through the full
 * validation and quality gate; the unfinished tail is simply dropped. Null when nothing complete is found.
 */
export function salvageQuestions(text: string): unknown[] | null {
  const key = text.indexOf('"questions"');
  const open = text.indexOf("[", key >= 0 ? key : 0);
  if (open === -1) return null;
  const found: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          found.push(JSON.parse(text.slice(objectStart, i + 1)));
        } catch {
          /* a damaged object: skip it */
        }
        objectStart = -1;
      }
      if (depth < 0) break;
    } else if (ch === "]" && depth === 0) break;
  }
  return found.length > 0 ? found : null;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s.length > 0 && s.length <= max ? s : null;
};

export const normalizeText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const words = (s: string) => new Set(normalizeText(s).split(" ").filter((w) => w.length >= 3));

/** Word-set overlap, 0..1. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

export const isDuplicate = (text: string, others: readonly string[]) => others.some((o) => similarity(text, o) >= DUPLICATE_SIMILARITY);

/** A multiple-choice stem must actually ask something: a question, or a sentence with a blank. */
const asksSomething = (text: string) => /\?\s*$/.test(text) || /_{2,}|\.\.\.\s*$|:\s*$/.test(text);

/** Small models sometimes append the names of the other JSON fields to the options array. */
const LEAKED_KEYS = new Set(["explanation", "difficulty", "source", "topic", "type", "question", "options", "correctanswer"]);

/**
 * Drops trailing options that are really leaked field names. Only the end of the list (removing one
 * from the middle would shift the answer's index), and only when it is clearly an artifact: two or
 * more in a row, or one extra beyond the four options. A lone "Source" as a genuine 4th option stays.
 */
function stripLeakedKeys(options: unknown[]): unknown[] {
  let run = 0;
  while (run < options.length) {
    const o = options[options.length - 1 - run];
    if (typeof o === "string" && LEAKED_KEYS.has(normalizeText(o))) run++;
    else break;
  }
  return run >= 2 || (run === 1 && options.length > 4) ? options.slice(0, options.length - run) : options;
}

const VAGUE_OPTION = /^(all|none|both|neither)\s+of\s+(the\s+)?(above|these|them)\b/i;

/** The index the model means, or null if it is not exactly one valid option. */
function mcqAnswer(raw: unknown, options: string[]): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw >= 0 && raw < options.length ? raw : null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^[0-3]$/.test(s)) return Number(s);
    if (/^[A-Da-d]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
    const byText = options.findIndex((o) => normalizeText(o) === normalizeText(s));
    return byText >= 0 ? byText : null;
  }
  return null;
}

function trueFalseAnswer(raw: unknown): number | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (v === true || v === "true") return 0;
  if (v === false || v === "false") return 1;
  return null;
}

function pickDifficulty(raw: unknown, wanted: Difficulty): QuestionDifficulty {
  if (wanted !== "mixed") return wanted;
  return raw === "easy" || raw === "medium" || raw === "hard" ? raw : "medium";
}

export function validateQuestions(raw: readonly unknown[], ctx: ValidationContext): { accepted: ValidQuestion[]; rejected: Rejection[] } {
  const accepted: ValidQuestion[] = [];
  const rejected: Rejection[] = [];
  const remaining = { ...ctx.remaining };
  const seen = [...ctx.existing];
  const topics = new Map(ctx.allowedTopics.map((t) => [normalizeText(t), t]));
  const keys = new Set(ctx.sourceKeys);

  raw.forEach((item, index) => {
    const reject = (reason: string, code = "structure") => void rejected.push({ index, reason, code });
    if (!item || typeof item !== "object" || Array.isArray(item)) return reject("not an object");
    const q = item as Record<string, unknown>;

    const type = q.type;
    if (type !== "mcq" && type !== "true_false") return reject("unsupported question type");
    if ((remaining[type] ?? 0) <= 0) return reject(`more ${type} questions than requested`);

    const text = clean(q.question, MAX_QUESTION);
    if (!text || text.length < MIN_QUESTION) return reject("question text missing or the wrong length");

    const explanation = clean(q.explanation, MAX_EXPLANATION);
    if (!explanation || explanation.length < MIN_EXPLANATION) return reject("explanation missing or the wrong length");

    let options: string[];
    let correctIndex: number | null;
    if (type === "mcq") {
      const given = Array.isArray(q.options) ? stripLeakedKeys(q.options) : null;
      if (!given || given.length !== 4) return reject("a multiple-choice question needs exactly 4 options");
      const cleaned = given.map((o) => clean(typeof o === "number" ? String(o) : o, MAX_OPTION));
      if (cleaned.some((o) => o === null)) return reject("an option is empty or too long");
      options = cleaned as string[];
      if (new Set(options.map(normalizeText)).size !== 4) return reject("options are not distinct");
      if (options.some((o) => VAGUE_OPTION.test(o))) return reject('"all/none of the above" options are ambiguous');
      correctIndex = mcqAnswer(q.correctAnswer, options);
      if (correctIndex === null) return reject("the correct answer is not exactly one of the options");
    } else {
      options = [...TRUE_FALSE_OPTIONS];
      correctIndex = trueFalseAnswer(q.correctAnswer);
      if (correctIndex === null) return reject("the correct answer must be true or false");
    }

    if (type === "mcq" && !asksSomething(text)) return reject("a multiple-choice question must be phrased as a question");
    if (isDuplicate(text, seen)) return reject("duplicate of another question", "duplicate");

    // Topic: only from the allowed list. Anything else is dropped, never invented.
    const topicRaw = clean(q.topic, 100);
    const topic = topicRaw ? (topics.get(normalizeText(topicRaw)) ?? null) : null;
    const sourceKey = typeof q.source === "string" && keys.has(q.source.trim()) ? q.source.trim() : null;
    const evidence = clean(q.evidence, MAX_EVIDENCE);

    const candidate: ValidQuestion = { type, text, options, correctIndex, explanation, topic, difficulty: pickDifficulty(q.difficulty, ctx.difficulty), sourceKey, evidence };
    const failure = ctx.quality?.(candidate);
    if (failure) return reject(failure.reason, failure.code);

    remaining[type] = (remaining[type] ?? 0) - 1;
    seen.push(text);
    accepted.push(candidate);
  });

  return { accepted, rejected };
}

/** Fisher-Yates over a copy, with an injectable RNG so tests are deterministic. */
export function shuffled<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Models tend to favour certain answer positions. Shuffle MCQ options and recompute the correct
 * index so the position of the right answer carries no information. True/False keeps True, False.
 */
export function shuffleOptions(q: ValidQuestion, rng: () => number = Math.random): ValidQuestion {
  if (q.type !== "mcq") return q;
  const order = shuffled(q.options.map((_, i) => i), rng);
  return { ...q, options: order.map((i) => q.options[i]!), correctIndex: order.indexOf(q.correctIndex) };
}
