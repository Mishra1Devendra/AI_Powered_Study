import { PLANNER_LIMITS, type KnowledgeLevel, type PlanSubject } from "@copilot/shared";

/**
 * Turns the model's untrusted JSON into a topic plan we are willing to schedule. The model can only
 * ever supply topic NAMES, an order and a suggested length: it cannot add subjects, dates or
 * anything executable - unknown fields are ignored and every string is length-limited and cleaned.
 */

export interface TopicPlan {
  summary: string | null;
  subjects: Array<{ name: string; topics: Array<{ topic: string; minutes: number }> }>;
}

export class PlanAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanAiError";
  }
}

const DEFAULT_MINUTES: Record<KnowledgeLevel, number> = { beginner: 45, intermediate: 40, advanced: 30 };
const MAX_FIRST_SESSION = 90;
/** The prompt asks for 3-8 topics; a small model sometimes writes many more for the first subject, crowding out the rest. */
export const MAX_AI_TOPICS_PER_SUBJECT = 8;

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Anything that looks like the model scheduling by itself ("Day 3", "2026-10-05", "Week 2:") is stripped from a topic name. */
const SCHEDULE_PREFIX = /^(day|week|session)\s*\d+\s*[:.\-–—]\s*|^\d{4}-\d{2}-\d{2}\s*[:.\-–—]?\s*/i;

/** The JSON object in the model's reply (tolerates Markdown fences and a sentence around it), or null. */
export function parsePlanJson(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced?.[1]) body = fenced[1];
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const unescape = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};

/**
 * Recovers the complete parts of an answer that was cut off (a local model can stop at its token
 * limit mid-object). Keeps every subject name and every COMPLETE topic seen after it; anything
 * half-written is dropped. Returns null when nothing usable is left. The result still goes through
 * `validateTopicPlan`, exactly like a normal answer.
 */
export function salvagePlanJson(text: string): { summary?: string; subjects: Array<{ subject: string; topics: Array<{ topic: string; minutes?: number }> }> } | null {
  const scan = new RegExp(String.raw`"subject"\s*:\s*${STR}|\{([^{}]*"topic"\s*:\s*${STR}[^{}]*)\}|"topics"\s*:\s*\[((?:\s*${STR}\s*,?)+)`, "g");
  const subjects: Array<{ subject: string; topics: Array<{ topic: string; minutes?: number }> }> = [];
  for (const m of text.matchAll(scan)) {
    if (m[1] !== undefined) {
      subjects.push({ subject: unescape(m[1]), topics: [] });
      continue;
    }
    const current = subjects[subjects.length - 1];
    if (!current) continue;
    if (m[2] !== undefined && m[3] !== undefined) {
      const minutes = /"minutes"\s*:\s*(\d+)/.exec(m[2])?.[1];
      current.topics.push({ topic: unescape(m[3]), ...(minutes ? { minutes: Number(minutes) } : {}) });
    } else if (m[4] !== undefined) {
      for (const s of m[4].matchAll(new RegExp(STR, "g"))) current.topics.push({ topic: unescape(s[1]!) });
    }
  }
  if (!subjects.some((s) => s.topics.length > 0)) return null;
  const summary = new RegExp(String.raw`"summary"\s*:\s*${STR}`).exec(text)?.[1];
  return { ...(summary ? { summary: unescape(summary) } : {}), subjects };
}

export interface TopicValidation {
  plan: TopicPlan;
  /** Things that were ignored or repaired, for logging. */
  notes: string[];
  /** Whether the AI contributed at least one usable topic (otherwise the plan is only the student's own topics). */
  aiTopics: number;
}

export function validateTopicPlan(raw: unknown, subjects: readonly PlanSubject[], minutesPerDay: number, level: KnowledgeLevel): TopicValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as { subjects?: unknown }).subjects)) {
    throw new PlanAiError("The local AI's plan was not in the expected format. Nothing was saved. Please try again.");
  }
  const notes: string[] = [];
  const cap = Math.min(MAX_FIRST_SESSION, minutesPerDay);
  const fallbackMinutes = Math.min(DEFAULT_MINUTES[level], cap);
  const byName = new Map(subjects.map((s) => [norm(s.name), s]));
  const aiBySubject = new Map<string, Array<{ topic: string; minutes: number }>>();
  let aiTopics = 0;

  for (const entry of (raw as { subjects: unknown[] }).subjects) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const subject = byName.get(norm(clean(e.subject ?? e.name, PLANNER_LIMITS.subjectMaxChars)));
    if (!subject) {
      notes.push(`ignored a subject that was not chosen: ${clean(e.subject ?? e.name, 60) || "(unnamed)"}`);
      continue;
    }
    const list = aiBySubject.get(subject.name) ?? [];
    for (const t of Array.isArray(e.topics) ? e.topics : []) {
      const rawName = typeof t === "string" ? t : t && typeof t === "object" ? (t as Record<string, unknown>).topic ?? (t as Record<string, unknown>).name : "";
      const topic = clean(rawName, PLANNER_LIMITS.topicMaxChars).replace(SCHEDULE_PREFIX, "").trim();
      if (topic.length < 2 || norm(topic) === "") continue;
      const m = typeof t === "object" && t ? Number((t as Record<string, unknown>).minutes) : NaN;
      const minutes = Number.isFinite(m) && m > 0 ? Math.min(cap, Math.max(PLANNER_LIMITS.minSessionMinutes, Math.round(m / 5) * 5)) : fallbackMinutes;
      if (Number.isFinite(m) && m > cap) notes.push(`shortened "${topic}" from ${m} to ${minutes} minutes (daily limit)`);
      list.push({ topic, minutes });
    }
    aiBySubject.set(subject.name, list);
  }

  const out: TopicPlan["subjects"] = [];
  for (const s of subjects) {
    const seen = new Set<string>();
    const topics: Array<{ topic: string; minutes: number }> = [];
    const add = (topic: string, minutes: number) => {
      const key = norm(topic);
      if (!key || seen.has(key) || topics.length >= PLANNER_LIMITS.maxTopicsPerSubject) return false;
      seen.add(key);
      topics.push({ topic, minutes });
      return true;
    };
    // The student's own topics always come first: their intent wins over the model's.
    for (const t of s.topics) add(t, fallbackMinutes);
    let fromAi = 0;
    for (const t of aiBySubject.get(s.name) ?? []) {
      if (fromAi >= MAX_AI_TOPICS_PER_SUBJECT) {
        notes.push(`kept the first ${MAX_AI_TOPICS_PER_SUBJECT} suggested topics for ${s.name}`);
        break;
      }
      if (add(t.topic, t.minutes)) (fromAi++, aiTopics++);
    }
    if (topics.length === 0) {
      notes.push(`no usable topics for ${s.name}: using a general review block`);
      add("General review", fallbackMinutes);
    }
    out.push({ name: s.name, topics });
  }

  if (aiTopics === 0 && subjects.every((s) => s.topics.length === 0)) {
    throw new PlanAiError("The local AI did not suggest any usable topics. Nothing was saved. Please try again, or type a few topics for each subject.");
  }
  const summary = clean((raw as { summary?: unknown }).summary, 400) || null;
  return { plan: { summary, subjects: out }, notes, aiTopics };
}
