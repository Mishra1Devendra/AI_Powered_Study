import {
  ACTIVITY_LABEL,
  RECOMMENDATION_LIMITS,
  priorityFor,
  type Recommendation,
  type RecommendationAction,
  type RecommendationFacts,
  type RecommendationsResponse,
  type RecommendationType,
  type TopicStat,
} from "@copilot/shared";
import { addDays, daysBetween } from "../planner/dates.js";
import { boundsForDays, classifySession, norm, round1, topicAnalysis, type AttemptFact, type BreakdownFact, type SessionFact, type VivaFact } from "../progress/compute.js";

/**
 * The recommendation engine: pure, deterministic and AI-free. It takes facts the application already calculated or
 * read from the database (quiz results, repeated misses, vivas, study sessions, tutor activity, notes behind quiz
 * questions) and decides what the student should do next and why. The points are documented in
 * packages/shared/src/recommendations.ts. Nothing is invented: every sentence of a reason is built from a number
 * that is in `facts`, and a topic with too little evidence is never called weak.
 */

/** Questions the student got wrong in two or more attempts, grouped by topic. */
export interface RepeatedFact {
  topic: string;
  subject: string | null;
  /** Distinct questions missed in 2+ attempts. */
  questions: number;
}

/** A note that a topic's quiz questions were made from. */
export interface SourceFact {
  topic: string;
  documentId: string;
  title: string;
}

/** The last day the student used the AI Tutor on a topic. */
export interface TutorFact {
  topic: string;
  subject: string | null;
  date: string;
}

export interface EngineInput {
  today: string;
  sessions: readonly SessionFact[];
  attempts: readonly AttemptFact[];
  breakdown: readonly BreakdownFact[];
  viva: readonly VivaFact[];
  repeated: readonly RepeatedFact[];
  sources: readonly SourceFact[];
  tutor: readonly TutorFact[];
}

interface Row {
  key: string;
  topic: string;
  subject: string | null;
  stat: TopicStat | null;
  attempts: number;
  repeated: number;
  vivaScores: number[];
  lastDate: string | null;
  scheduled: string | null;
  docs: SourceFact[];
}

const L = RECOMMENDATION_LIMITS;
const TYPE_RANK: Record<RecommendationType, number> = { URGENT_REVISION: 0, WEAK_TOPIC: 1, REPEATED_MISTAKE: 2, PRACTICE_MORE: 3, VIVA_PRACTICE: 4, UPCOMING_STUDY: 5, IMPROVING: 6, MAINTAIN_STRENGTH: 7 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const later = (a: string | null, b: string) => (a === null || b > a ? b : a);

const avg = (list: readonly number[]) => (list.length ? round1(list.reduce((s, v) => s + v, 0) / list.length) : null);

function buildRows(input: EngineInput): Map<string, Row> {
  const { today } = input;
  const rows = new Map<string, Row>();
  const row = (topic: string, subject: string | null): Row => {
    const key = norm(topic);
    let r = rows.get(key);
    if (!r) {
      r = { key, topic: topic.trim().replace(/\s+/g, " "), subject, stat: null, attempts: 0, repeated: 0, vivaScores: [], lastDate: null, scheduled: null, docs: [] };
      rows.set(key, r);
    }
    if (r.subject === null && subject) r.subject = subject;
    return r;
  };

  // Quiz topics: accuracy, level and improvement all come from the same code as the Progress page.
  const analysis = topicAnalysis(input.sessions, boundsForDays(null, today), today, input.attempts, input.breakdown);
  for (const t of analysis.topics) row(t.topic, t.subject).stat = t;

  const attemptDate = new Map(input.attempts.map((a) => [a.attemptId, a.date]));
  const seen = new Map<string, Set<string>>();
  for (const b of input.breakdown) {
    if (b.topic === null) continue;
    const r = rows.get(norm(b.topic));
    if (!r) continue;
    (seen.get(r.key) ?? seen.set(r.key, new Set()).get(r.key)!).add(b.attemptId);
    const d = attemptDate.get(b.attemptId);
    if (d) r.lastDate = later(r.lastDate, d);
  }
  for (const [k, ids] of seen) rows.get(k)!.attempts = ids.size;

  for (const v of input.viva) {
    if (!v.topic) continue;
    const r = row(v.topic, v.subject);
    r.vivaScores.push(v.score);
    r.lastDate = later(r.lastDate, v.date);
  }
  for (const f of input.repeated) {
    const r = rows.get(norm(f.topic)) ?? row(f.topic, f.subject);
    r.repeated = Math.max(r.repeated, f.questions);
  }
  // Study activity only adds context to topics we already know something about; it never creates a topic by itself.
  for (const s of input.sessions) {
    const r = rows.get(norm(s.topic));
    if (!r) continue;
    const kind = classifySession(s, today);
    if (kind === "completed" && s.completedDate) r.lastDate = later(r.lastDate, s.completedDate);
    if (kind === "upcoming" && (r.scheduled === null || s.date < r.scheduled)) r.scheduled = s.date;
  }
  for (const t of input.tutor) {
    const r = rows.get(norm(t.topic));
    if (r) r.lastDate = later(r.lastDate, t.date);
  }
  for (const d of input.sources) {
    const r = rows.get(norm(d.topic));
    if (r && !r.docs.some((x) => x.documentId === d.documentId)) r.docs.push(d);
  }
  return rows;
}

interface Scored {
  /** Points that say how much the topic needs work (0 = nothing needs fixing). */
  need: number;
  days: number | null;
  vivaAvg: number | null;
}

function score(r: Row, today: string): Scored {
  let need = 0;
  const st = r.stat;
  if (st?.level === "weak") need += 60 + Math.round(((50 - (st.accuracy ?? 0)) / 50) * 10);
  else if (st?.level === "needs_practice") need += 22;
  else if (st?.level === "insufficient" && st.total > 0) need += 12;
  need += Math.min(40, 20 * r.repeated);
  const vivaAvg = avg(r.vivaScores);
  if (vivaAvg !== null) need += vivaAvg < 50 ? 35 : vivaAvg < 75 ? 12 : 0;
  const days = r.lastDate ? Math.max(0, daysBetween(r.lastDate, today)) : null;
  if (need > 0 && days !== null) need += days >= L.veryStaleDays ? 12 : days >= L.staleDays ? 6 : 0;
  if (need > 0 && r.scheduled !== null) {
    const until = daysBetween(today, r.scheduled);
    need += until <= 3 ? 14 : until <= 7 ? 7 : 0;
  }
  return { need: Math.min(100, need), days, vivaAvg };
}

const isImproving = (r: Row) => r.stat?.trend != null && r.stat.trend.delta >= 10 && r.stat.level !== "weak" && r.repeated === 0;

function pickType(r: Row, s: Scored): RecommendationType | null {
  if (s.need === 0) {
    if (isImproving(r)) return "IMPROVING";
    return r.stat?.level === "strong" ? "MAINTAIN_STRENGTH" : null;
  }
  if (r.stat?.level === "weak") return s.need >= 80 ? "URGENT_REVISION" : "WEAK_TOPIC";
  if (isImproving(r)) return "IMPROVING";
  if (r.repeated > 0) return "REPEATED_MISTAKE";
  if (r.stat?.level === "needs_practice" || (r.stat?.level === "insufficient" && r.stat.total > 0)) return "PRACTICE_MORE";
  return "VIVA_PRACTICE";
}

const T = (kind: RecommendationAction["kind"], label: string, over: Partial<RecommendationAction>): RecommendationAction => ({ kind, label, subject: null, topic: null, count: null, draft: null, documentId: null, sessionId: null, ...over });

function reasonFor(type: RecommendationType, r: Row, f: RecommendationFacts): string {
  const quiz =
    r.stat && f.accuracy !== null
      ? `You scored ${f.accuracy}% across ${plural(f.questions, "question")}${f.attempts > 1 ? ` in ${f.attempts} quiz attempts` : ""}.`
      : r.stat && f.questions > 0
        ? `You have answered only ${plural(f.questions, "question")} on this topic so far, which is too few to say how you are doing (5 are needed).`
        : null;
  const repeated = f.repeatedMisses > 0 ? `You got the same ${f.repeatedMisses === 1 ? "question" : `${f.repeatedMisses} questions`} wrong in more than one attempt.` : null;
  const viva = f.vivaAverage !== null ? `Your ${f.vivaSessions === 1 ? "viva score" : "average viva score"} on this topic is ${f.vivaAverage}%.` : null;
  const stale = f.daysSincePracticed !== null && f.daysSincePracticed >= L.staleDays ? `You last practiced it ${plural(f.daysSincePracticed, "day")} ago.` : null;
  const scheduled = f.scheduledOn ? `A study session on it is planned for ${f.scheduledOn}.` : null;
  switch (type) {
    case "IMPROVING":
      return `Your recent performance improved from ${f.trend!.previous}% to ${f.trend!.recent}%. Keep practicing to maintain progress.`;
    case "MAINTAIN_STRENGTH":
      return `${quiz ?? ""} ${stale ? `${stale} A short refresher keeps it fresh.` : "Nothing needs fixing right now."}`.trim();
    default:
      return [quiz, repeated, viva, stale, scheduled].filter(Boolean).join(" ");
  }
}

const TITLE: Record<RecommendationType, (t: string, stale: boolean) => string> = {
  URGENT_REVISION: (t) => `Revise ${t} now`,
  WEAK_TOPIC: (t) => `Revise ${t}`,
  REPEATED_MISTAKE: (t) => `Fix repeated mistakes in ${t}`,
  PRACTICE_MORE: (t) => `Practice ${t}`,
  VIVA_PRACTICE: (t) => `Practice a viva on ${t}`,
  UPCOMING_STUDY: (t) => `Continue: ${t}`,
  IMPROVING: (t) => `You're improving at ${t}`,
  MAINTAIN_STRENGTH: (t, stale) => (stale ? `Keep ${t} fresh` : `${t} is a strength`),
};

function topicRecommendation(r: Row, s: Scored, type: RecommendationType): { rec: Recommendation; points: number } {
  const st = r.stat;
  const facts: RecommendationFacts = {
    accuracy: st?.accuracy ?? null,
    questions: st?.total ?? 0,
    attempts: r.attempts,
    repeatedMisses: r.repeated,
    daysSincePracticed: s.days,
    vivaAverage: s.vivaAvg,
    vivaSessions: r.vivaScores.length,
    trend: st?.trend ? { previous: st.trend.previous, recent: st.trend.recent } : null,
    scheduledOn: r.scheduled,
  };
  const stale = s.days !== null && s.days >= L.veryStaleDays;
  const points = type === "IMPROVING" ? 20 + (s.need > 0 ? Math.min(10, s.need) : 0) : type === "MAINTAIN_STRENGTH" ? 8 + (stale ? 10 : 0) : s.need;

  const mini = type === "MAINTAIN_STRENGTH";
  const count = mini ? L.miniQuizCount : L.quizCount;
  const quiz = T("quiz", mini ? "Take a mini quiz" : type === "IMPROVING" ? "Practice" : "Start Practice", { subject: r.subject, topic: r.topic, count });
  const tutor = T("tutor", "Ask Tutor", {
    subject: r.subject,
    topic: r.topic,
    draft: r.repeated > 0 ? `Explain the common mistakes I make in ${r.topic}` : st?.level === "weak" || st?.level === "needs_practice" ? `Explain ${r.topic} step by step, then test my understanding` : `Give me a short revision of ${r.topic}`,
  });
  const viva = r.subject ? T("viva", "Practice Viva", { subject: r.subject, topic: r.topic, count: L.vivaCount }) : null;
  const notes = r.docs[0] ? T("notes", "Review notes", { documentId: r.docs[0].documentId, topic: r.topic }) : null;

  let primary: RecommendationAction["kind"];
  let actionText: string;
  let ordered: Array<RecommendationAction | null>;
  switch (type) {
    case "REPEATED_MISTAKE":
      primary = "tutor";
      actionText = "Ask the AI Tutor to explain the common mistakes, then practice";
      ordered = [tutor, quiz, notes];
      break;
    case "VIVA_PRACTICE":
      primary = "viva";
      actionText = `Practice a ${L.vivaCount}-question viva`;
      ordered = [viva, tutor, notes];
      break;
    case "MAINTAIN_STRENGTH":
      primary = "quiz";
      actionText = stale ? `A ${L.miniQuizCount}-question mini quiz keeps it fresh` : `Take a ${L.miniQuizCount}-question mini quiz now and then`;
      ordered = [quiz, viva];
      break;
    case "IMPROVING":
      primary = "quiz";
      actionText = `Practice ${L.quizCount} more questions to lock it in`;
      ordered = [quiz, tutor];
      break;
    default:
      primary = "quiz";
      actionText = `Practice ${L.quizCount} questions`;
      ordered = [quiz, tutor, notes, viva];
  }
  const actions = ordered.filter((a): a is RecommendationAction => a !== null).slice(0, 4);
  return {
    points,
    rec: {
      id: `${type}:${r.key}`,
      type,
      priority: priorityFor(points),
      subject: r.subject,
      topic: r.topic,
      title: TITLE[type](r.topic, stale),
      reason: reasonFor(type, r, facts),
      actionText,
      primary,
      actions,
      facts,
    },
  };
}

const EMPTY_FACTS: RecommendationFacts = { accuracy: null, questions: 0, attempts: 0, repeatedMisses: 0, daysSincePracticed: null, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null };

/** "Continue your planned session" (nearest upcoming one) and "Catch up" (the latest missed one on the active plan). */
function planRecommendations(input: EngineInput, rows: Map<string, Row>, scored: Map<string, Scored>): Array<{ rec: Recommendation; points: number }> {
  const { today } = input;
  const out: Array<{ rec: Recommendation; points: number }> = [];
  const upcoming = input.sessions.filter((s) => classifySession(s, today) === "upcoming").sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const nearest = upcoming[0]?.date;
  if (nearest !== undefined && nearest <= addDays(today, 7)) {
    for (const s of upcoming.filter((u) => u.date === nearest).slice(0, 2)) {
      const r = rows.get(norm(s.topic));
      const need = r ? (scored.get(r.key)?.need ?? 0) : 0;
      const when = s.date === today ? "today" : s.date;
      const points = 30 + (s.date === today ? 10 : 0) + Math.round(need / 4);
      const weakNote = r?.stat?.accuracy != null && need > 0 ? ` You scored ${r.stat.accuracy}% on this topic in quizzes, so it is worth the time.` : "";
      out.push({
        points,
        rec: {
          id: `UPCOMING_STUDY:${s.id}`,
          type: "UPCOMING_STUDY",
          priority: priorityFor(points),
          subject: s.subject,
          topic: s.topic,
          title: TITLE.UPCOMING_STUDY(s.topic, false),
          reason: `Planned for ${when}: ${ACTIVITY_LABEL[s.activityType].toLowerCase()}, ${s.durationMinutes} min.${weakNote}`,
          actionText: "Continue your planned study session",
          primary: "plan",
          actions: [T("plan", "Open session", { subject: s.subject, topic: s.topic, sessionId: s.id }), T("tutor", "Ask Tutor", { subject: s.subject, topic: s.topic, draft: `Help me prepare for studying ${s.topic} (${s.subject})` })],
          facts: { ...EMPTY_FACTS, scheduledOn: s.date, accuracy: r?.stat?.accuracy ?? null, questions: r?.stat?.total ?? 0 },
        },
      });
    }
  }
  const missed = input.sessions.filter((s) => classifySession(s, today) === "missed" && s.planStatus === "active" && s.status !== "missed").sort((a, b) => b.date.localeCompare(a.date))[0];
  if (missed) {
    out.push({
      points: 40,
      rec: {
        id: `UPCOMING_STUDY:${missed.id}`,
        type: "UPCOMING_STUDY",
        priority: priorityFor(40),
        subject: missed.subject,
        topic: missed.topic,
        title: `Catch up: ${missed.topic}`,
        reason: `You missed this session on ${missed.date}. You can reschedule it or keep it as missed in your study plan.`,
        actionText: "Reschedule or catch up on the missed session",
        primary: "plan",
        actions: [T("plan", "Open session", { subject: missed.subject, topic: missed.topic, sessionId: missed.id })],
        facts: { ...EMPTY_FACTS, scheduledOn: missed.date },
      },
    });
  }
  return out;
}

export function buildRecommendations(input: EngineInput, limit: number = L.defaultLimit): RecommendationsResponse {
  const rows = buildRows(input);
  const scored = new Map<string, Scored>();
  const items: Array<{ rec: Recommendation; points: number }> = [];
  let strongKept = 0;
  let improvingKept = 0;

  for (const r of [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const s = score(r, input.today);
    scored.set(r.key, s);
    const type = pickType(r, s);
    if (type === null) continue;
    const item = topicRecommendation(r, s, type);
    items.push(item);
  }
  items.push(...planRecommendations(input, rows, scored));

  const rank = (a: { rec: Recommendation; points: number }, b: { rec: Recommendation; points: number }) =>
    b.points - a.points || TYPE_RANK[a.rec.type] - TYPE_RANK[b.rec.type] || a.rec.title.localeCompare(b.rec.title);
  const kept = items.sort(rank).filter(({ rec }) => {
    if (rec.type === "MAINTAIN_STRENGTH") return ++strongKept <= 5;
    if (rec.type === "IMPROVING") return ++improvingKept <= 5;
    return true;
  });

  const withEvidence = [...rows.values()].filter((r) => (r.stat?.total ?? 0) > 0 || r.vivaScores.length > 0);
  return {
    recommendations: kept.slice(0, limit).map((i) => i.rec),
    summary: {
      topicsAnalyzed: rows.size,
      topicsWithEnoughData: [...rows.values()].filter((r) => (r.stat !== null && r.stat.level !== "insufficient") || r.vivaScores.length > 0).length,
      hasEnoughData: withEvidence.length > 0,
    },
    today: input.today,
  };
}

/** Exposed for tests and the explanation prompt: how much a topic needs work, 0-100. */
export const topicNeed = (input: EngineInput, topic: string): number => {
  const rows = buildRows(input);
  const r = rows.get(norm(topic));
  return r ? score(r, input.today).need : 0;
};
