import {
  MASTERY_LEVELS,
  PROGRESS_THRESHOLDS,
  masteryLevel,
  type ActivityType,
  type PlanStatus,
  type ProgressActivity,
  type ProgressRange,
  type QuizStats,
  type SessionStatus,
  type Streak,
  type StudyTime,
  type SubjectStat,
  type VivaProgress,
  type TopicStat,
} from "@copilot/shared";
import { addDays, daysBetween, weekStart } from "../planner/dates.js";

/**
 * Pure analytics. Everything here takes plain facts (already read from the database, with dates
 * already converted to the student's LOCAL calendar days) and returns numbers. No I/O, no clock,
 * no AI. The definitions it implements are written down in packages/shared/src/progress.ts.
 */

/* ------------------------------------------------------------------ facts */

export interface SessionFact {
  id: string;
  /** The day the session was scheduled for (local calendar date). */
  date: string;
  /** The local day it was completed on (null unless completed). */
  completedDate: string | null;
  status: SessionStatus;
  durationMinutes: number;
  subject: string;
  topic: string;
  activityType: ActivityType;
  /** The plan the session belongs to. */
  planStatus: PlanStatus;
}

export interface AttemptFact {
  attemptId: string;
  quizId: string;
  quizTitle: string;
  subject: string | null;
  /** When the attempt was finished. */
  at: Date;
  /** The local day it was finished on. */
  date: string;
  percentage: number;
}

/** Questions of ONE finished attempt, grouped by topic and difficulty. */
export interface BreakdownFact {
  attemptId: string;
  topic: string | null;
  difficulty: "easy" | "medium" | "hard";
  total: number;
  answered: number;
  correct: number;
}

export interface RecentSessionFact {
  id: string;
  status: "completed" | "skipped";
  /** When it was completed (or, for a skipped session, last changed - which is when it was skipped). */
  at: Date;
  date: string;
  subject: string;
  topic: string;
  durationMinutes: number;
}

/* ------------------------------------------------------------------ small helpers */

export const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (correct: number, total: number) => (total > 0 ? round1((correct / total) * 100) : null);
export const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const RANGE_DAYS: Record<ProgressRange, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };
/** The length of a range in days (null = all time). */
export const rangeDays = (range: ProgressRange) => RANGE_DAYS[range];

export interface Bounds {
  /** First local day of the period (null = from the beginning). */
  from: string | null;
  to: string;
  /** The period just before this one, same length (null for "All time"). */
  prevFrom: string | null;
  prevTo: string | null;
}

/** The period ends today and includes today: 7 days = today and the 6 days before it. */
export function boundsFor(range: ProgressRange, today: string): Bounds {
  return boundsForDays(RANGE_DAYS[range], today);
}

export function boundsForDays(days: number | null, today: string): Bounds {
  if (days === null) return { from: null, to: today, prevFrom: null, prevTo: null };
  const from = addDays(today, -(days - 1));
  return { from, to: today, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

const within = (day: string, from: string | null, to: string) => (from === null || day >= from) && day <= to;

/** A subject or topic is the same one whatever its capitalisation or spacing; the first spelling seen is shown. */
class Names {
  private readonly shown = new Map<string, string>();
  key(name: string): string {
    const k = norm(name);
    if (!this.shown.has(k)) this.shown.set(k, name.trim().replace(/\s+/g, " "));
    return k;
  }
  name(key: string): string {
    return this.shown.get(key) ?? key;
  }
}

/* ------------------------------------------------------------------ sessions */

type SessionClass = "completed" | "skipped" | "missed" | "upcoming";

/**
 * What a session counts as, or null when it must not be counted at all.
 * - completed / skipped: explicit student actions, from any plan.
 * - missed: explicitly kept as missed (any plan), or still planned/in progress after its day - but only on the
 *   active plan, because a replaced plan's untouched sessions are not the student's misses.
 * - upcoming: planned/in progress, today or later, on the active plan.
 * - rescheduled originals are history; their replacement is counted instead.
 */
export function classifySession(s: SessionFact, today: string): SessionClass | null {
  switch (s.status) {
    case "completed":
      return "completed";
    case "skipped":
      return "skipped";
    case "missed":
      return "missed";
    case "planned":
    case "in_progress":
      if (s.planStatus !== "active") return null;
      return s.date < today ? "missed" : "upcoming";
    default:
      return null;
  }
}

/** The local day a session belongs to: when it was done for completed sessions, otherwise the day it was scheduled. */
const dayOf = (s: SessionFact) => (s.status === "completed" ? (s.completedDate ?? s.date) : s.date);

export function studyTimeStats(sessions: readonly SessionFact[], bounds: Bounds, today: string, range: ProgressRange): StudyTime {
  const inRange = (s: SessionFact) => within(dayOf(s), bounds.from, bounds.to);
  let completed = 0;
  let skipped = 0;
  let missed = 0;
  let upcoming = 0;
  let totalMinutes = 0;
  const days = new Set<string>();
  const subjects = new Names();
  const bySubject = new Map<string, { minutes: number; sessions: number }>();
  const byActivity = new Map<ActivityType, { minutes: number; sessions: number }>();
  const byDay = new Map<string, { minutes: number; sessions: number }>();

  for (const s of sessions) {
    const kind = classifySession(s, today);
    if (kind === "upcoming") {
      upcoming++;
      continue;
    }
    if (!kind || !inRange(s)) continue;
    if (kind === "skipped") skipped++;
    else if (kind === "missed") missed++;
    else {
      completed++;
      totalMinutes += s.durationMinutes;
      const day = dayOf(s);
      days.add(day);
      const k = subjects.key(s.subject);
      const sub = bySubject.get(k) ?? { minutes: 0, sessions: 0 };
      bySubject.set(k, { minutes: sub.minutes + s.durationMinutes, sessions: sub.sessions + 1 });
      const act = byActivity.get(s.activityType) ?? { minutes: 0, sessions: 0 };
      byActivity.set(s.activityType, { minutes: act.minutes + s.durationMinutes, sessions: act.sessions + 1 });
      const d = byDay.get(day) ?? { minutes: 0, sessions: 0 };
      byDay.set(day, { minutes: d.minutes + s.durationMinutes, sessions: d.sessions + 1 });
    }
  }

  let previousMinutes: number | null = null;
  if (bounds.prevFrom !== null && bounds.prevTo !== null) {
    const prev = sessions.filter((s) => s.status === "completed" && within(dayOf(s), bounds.prevFrom, bounds.prevTo!)).reduce((m, s) => m + s.durationMinutes, 0);
    previousMinutes = prev > 0 ? prev : null;
  }

  // Bars: one per day for 7 and 30 days, one per week (Monday start) for 90 days and all time (latest 52 weeks).
  const granularity = range === "7d" || range === "30d" ? "day" : "week";
  const firstDay = bounds.from ?? [...byDay.keys()].sort()[0] ?? null;
  const byPeriod: StudyTime["byPeriod"] = [];
  if (firstDay !== null) {
    if (granularity === "day") {
      for (let d = firstDay; d <= bounds.to; d = addDays(d, 1)) byPeriod.push({ start: d, ...(byDay.get(d) ?? { minutes: 0, sessions: 0 }) });
    } else {
      const weeks = new Map<string, { minutes: number; sessions: number }>();
      for (const [d, v] of byDay) {
        const w = weekStart(d);
        const cur = weeks.get(w) ?? { minutes: 0, sessions: 0 };
        weeks.set(w, { minutes: cur.minutes + v.minutes, sessions: cur.sessions + v.sessions });
      }
      const last = weekStart(bounds.to);
      let first = weekStart(firstDay);
      if (daysBetween(first, last) / 7 >= 52) first = addDays(last, -51 * 7);
      for (let w = first; w <= last; w = addDays(w, 7)) byPeriod.push({ start: w, ...(weeks.get(w) ?? { minutes: 0, sessions: 0 }) });
    }
  }

  const due = completed + skipped + missed;
  return {
    totalMinutes,
    previousMinutes,
    completedSessions: completed,
    skippedSessions: skipped,
    missedSessions: missed,
    upcomingSessions: upcoming,
    completionRate: due > 0 ? pct(completed, due) : null,
    activeDays: days.size,
    averageMinutesPerActiveDay: days.size > 0 ? Math.round(totalMinutes / days.size) : null,
    granularity,
    byPeriod,
    bySubject: [...bySubject].map(([k, v]) => ({ subject: subjects.name(k), ...v })).sort((a, b) => b.minutes - a.minutes || a.subject.localeCompare(b.subject)),
    byActivity: [...byActivity]
      .map(([activityType, v]) => ({ activityType, ...v, percentage: totalMinutes > 0 ? round1((v.minutes / totalMinutes) * 100) : 0 }))
      .sort((a, b) => b.minutes - a.minutes),
  };
}

/* ------------------------------------------------------------------ streaks */

/**
 * `studyDates`: every local day (any order, duplicates allowed) with at least one completed session.
 * Several sessions on a day, or a day with only skipped sessions, make no difference to the day count.
 */
export function streakStats(studyDates: readonly string[], today: string): Streak {
  const days = [...new Set(studyDates)].sort();
  if (days.length === 0) return { current: null, longest: null, studyDays: 0, lastStudyDate: null };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = daysBetween(days[i - 1]!, days[i]!) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const last = days[days.length - 1]!;
  // Alive when the last study day is today, or yesterday (today is still to come).
  let current = 0;
  if (daysBetween(last, today) <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0 && daysBetween(days[i - 1]!, days[i]!) === 1; i--) current++;
  }
  return { current, longest, studyDays: days.length, lastStudyDate: last };
}

/* ------------------------------------------------------------------ quiz */

export function quizStats(attempts: readonly AttemptFact[], prevAttempts: readonly AttemptFact[], breakdown: readonly BreakdownFact[], quizzesAttempted: number): QuizStats {
  const ordered = [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime());
  const scores = ordered.map((a) => a.percentage);
  let questions = 0;
  let answered = 0;
  let correct = 0;
  const diff = new Map<string, { questions: number; correct: number }>();
  for (const b of breakdown) {
    questions += b.total;
    answered += b.answered;
    correct += b.correct;
    const d = diff.get(b.difficulty) ?? { questions: 0, correct: 0 };
    diff.set(b.difficulty, { questions: d.questions + b.total, correct: d.correct + b.correct });
  }
  const avg = (list: readonly number[]) => (list.length > 0 ? round1(list.reduce((s, v) => s + v, 0) / list.length) : null);
  return {
    attemptsCompleted: ordered.length,
    quizzesCompleted: new Set(ordered.map((a) => a.quizId)).size,
    quizzesAttempted,
    averageScore: avg(scores),
    highestScore: scores.length ? Math.max(...scores) : null,
    lowestScore: scores.length ? Math.min(...scores) : null,
    recentScore: scores.length ? scores[scores.length - 1]! : null,
    previousAverageScore: avg(prevAttempts.map((a) => a.percentage)),
    questions,
    correct,
    incorrect: answered - correct,
    unanswered: questions - answered,
    accuracy: pct(correct, questions),
    trend: ordered.slice(-30).map((a) => ({ attemptId: a.attemptId, date: a.date, percentage: a.percentage, quizTitle: a.quizTitle })),
    byDifficulty: (["easy", "medium", "hard"] as const).flatMap((difficulty) => {
      const d = diff.get(difficulty);
      return d ? [{ difficulty, questions: d.questions, correct: d.correct, accuracy: d.questions >= PROGRESS_THRESHOLDS.minQuestionsForMastery ? pct(d.correct, d.questions) : null }] : [];
    }),
  };
}

/* ------------------------------------------------------------------ topics and subjects */

interface Joined extends BreakdownFact {
  at: Date;
  subject: string | null;
  quizId: string;
}

const join = (attempts: readonly AttemptFact[], breakdown: readonly BreakdownFact[]): Joined[] => {
  const byId = new Map(attempts.map((a) => [a.attemptId, a]));
  return breakdown.flatMap((b) => {
    const a = byId.get(b.attemptId);
    return a ? [{ ...b, at: a.at, subject: a.subject, quizId: a.quizId }] : [];
  });
};

/**
 * Earlier vs recent accuracy for one topic. The recent part is the newest attempts, added until they hold
 * at least MIN_QUESTIONS_PER_TREND_WINDOW questions; everything older is "earlier" and must also hold that
 * many. With less than that on either side there is no comparison (null) - never a guess.
 */
function trendOf(rows: readonly Joined[]): TopicStat["trend"] {
  const min = PROGRESS_THRESHOLDS.minQuestionsPerTrendWindow;
  const perAttempt = new Map<string, { at: number; correct: number; total: number }>();
  for (const r of rows) {
    const cur = perAttempt.get(r.attemptId) ?? { at: r.at.getTime(), correct: 0, total: 0 };
    perAttempt.set(r.attemptId, { at: cur.at, correct: cur.correct + r.correct, total: cur.total + r.total });
  }
  const newestFirst = [...perAttempt.values()].sort((a, b) => b.at - a.at);
  let recent = { correct: 0, total: 0 };
  let i = 0;
  while (i < newestFirst.length && recent.total < min) {
    recent = { correct: recent.correct + newestFirst[i]!.correct, total: recent.total + newestFirst[i]!.total };
    i++;
  }
  const earlier = newestFirst.slice(i).reduce((s, a) => ({ correct: s.correct + a.correct, total: s.total + a.total }), { correct: 0, total: 0 });
  if (recent.total < min || earlier.total < min) return null;
  const previous = round1((earlier.correct / earlier.total) * 100);
  const now = round1((recent.correct / recent.total) * 100);
  return { previous, recent: now, delta: round1(now - previous) };
}

function topicStatsFrom(rows: readonly Joined[]): TopicStat[] {
  const names = new Names();
  const groups = new Map<string, Joined[]>();
  for (const r of rows) {
    if (r.topic === null) continue; // questions without a reliably known topic are never given an invented one
    const k = names.key(r.topic);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].map(([k, list]) => {
    const total = list.reduce((s, r) => s + r.total, 0);
    const correct = list.reduce((s, r) => s + r.correct, 0);
    const level = masteryLevel(correct, total);
    // The subject this topic was mostly asked under (null when its quizzes had no subject).
    const bySubject = new Map<string, { name: string; n: number }>();
    for (const r of list) if (r.subject) bySubject.set(norm(r.subject), { name: bySubject.get(norm(r.subject))?.name ?? r.subject, n: (bySubject.get(norm(r.subject))?.n ?? 0) + r.total });
    const subject = [...bySubject.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))[0]?.name ?? null;
    return { topic: names.name(k), subject, correct, total, accuracy: level === "insufficient" ? null : pct(correct, total), level, trend: trendOf(list) };
  });
}

/** Lowest accuracy first; topics without enough data last (most questions first). */
const byWeakness = (a: TopicStat, b: TopicStat) =>
  Number(a.accuracy === null) - Number(b.accuracy === null) || (a.accuracy ?? 0) - (b.accuracy ?? 0) || b.total - a.total || a.topic.localeCompare(b.topic);

export interface TopicAnalysis {
  topics: TopicStat[];
  subjects: SubjectStat[];
  summary: { studied: number; withEnoughData: number; strong: number; needsPractice: number; weak: number };
  weakAreas: TopicStat[];
  improving: TopicStat[];
  improvementComparable: boolean;
}

export function topicAnalysis(sessions: readonly SessionFact[], bounds: Bounds, today: string, attempts: readonly AttemptFact[], breakdown: readonly BreakdownFact[]): TopicAnalysis {
  const rows = join(attempts, breakdown);
  const topics = topicStatsFrom(rows).sort(byWeakness);

  // Topics studied = answered in quizzes + completed in sessions (the placeholder "Full practice test" is not a topic).
  const studiedNames = new Names();
  const studied = new Set(topics.map((t) => studiedNames.key(t.topic)));
  const done = sessions.filter((s) => classifySession(s, today) === "completed" && within(dayOf(s), bounds.from, bounds.to));
  for (const s of done) if (s.activityType !== "mock_test") studied.add(studiedNames.key(s.topic));

  // Subjects: every subject with study time or quiz questions in the period.
  const subjectNames = new Names();
  const bySubject = new Map<string, { minutes: number; sessions: number; rows: Joined[] }>();
  const entry = (k: string) => bySubject.get(k) ?? { minutes: 0, sessions: 0, rows: [] };
  for (const s of done) {
    const k = subjectNames.key(s.subject);
    const e = entry(k);
    bySubject.set(k, { ...e, minutes: e.minutes + s.durationMinutes, sessions: e.sessions + 1 });
  }
  for (const r of rows) {
    if (!r.subject) continue;
    const k = subjectNames.key(r.subject);
    const e = entry(k);
    bySubject.set(k, { ...e, rows: [...e.rows, r] });
  }
  const subjects: SubjectStat[] = [...bySubject].map(([k, v]) => {
    const questions = v.rows.reduce((s, r) => s + r.total, 0);
    const correct = v.rows.reduce((s, r) => s + r.correct, 0);
    const level = masteryLevel(correct, questions);
    return {
      subject: subjectNames.name(k),
      studyMinutes: v.minutes,
      completedSessions: v.sessions,
      quizzes: new Set(v.rows.map((r) => r.quizId)).size,
      questions,
      accuracy: level === "insufficient" ? null : pct(correct, questions),
      level,
      topics: topicStatsFrom(v.rows).sort(byWeakness).slice(0, 12),
    };
  });
  subjects.sort((a, b) => b.studyMinutes - a.studyMinutes || b.questions - a.questions || a.subject.localeCompare(b.subject));

  const count = (level: (typeof MASTERY_LEVELS)[number]) => topics.filter((t) => t.level === level).length;
  return {
    topics: topics.slice(0, 50),
    subjects,
    summary: {
      studied: studied.size,
      withEnoughData: topics.filter((t) => t.level !== "insufficient").length,
      strong: count("strong"),
      needsPractice: count("needs_practice"),
      weak: count("weak"),
    },
    weakAreas: topics.filter((t) => t.level === "weak").slice(0, 5),
    improving: topics
      .filter((t) => t.trend !== null && t.trend.delta >= PROGRESS_THRESHOLDS.improvingDelta)
      .sort((a, b) => b.trend!.delta - a.trend!.delta || a.topic.localeCompare(b.topic))
      .slice(0, 5),
    improvementComparable: topics.some((t) => t.trend !== null),
  };
}

/* ------------------------------------------------------------------ recent activity */

const minutesText = (m: number) => `${m} min`;

export function recentActivity(sessions: readonly RecentSessionFact[], attempts: readonly AttemptFact[], limit: number): ProgressActivity[] {
  const events: ProgressActivity[] = [
    ...sessions.map((s) => ({
      id: `session-${s.status}-${s.id}`,
      type: s.status === "completed" ? ("session_completed" as const) : ("session_skipped" as const),
      at: s.at.toISOString(),
      title: `${s.status === "completed" ? "Completed" : "Skipped"} ${s.subject} — ${s.topic}`,
      detail: minutesText(s.durationMinutes),
      date: s.date,
      href: `/study-plan?session=${s.id}`,
    })),
    ...attempts.map((a) => ({
      id: `quiz-${a.attemptId}`,
      type: "quiz_completed" as const,
      at: a.at.toISOString(),
      title: `Completed quiz — ${a.quizTitle}`,
      detail: `${Math.round(a.percentage)}%`,
      date: a.date,
      href: `/quiz/attempt/${a.attemptId}/result`,
    })),
  ];
  return events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit);
}

/* ------------------------------------------------------------------ viva */

/** One COMPLETED viva (finished in the period). `c/p/l/f` are the averages of its four 0-10 answer scores. */
export interface VivaFact {
  id: string;
  subject: string;
  topic: string | null;
  /** 0-100 */
  score: number;
  /** The local day it was completed on. */
  date: string;
  at: Date;
  c: number | null;
  p: number | null;
  l: number | null;
  f: number | null;
}

/** The latest completed viva of all time (for the dashboard card), and how many there are. */
export interface LastViva {
  subject: string;
  topic: string | null;
  score: number;
  total: number;
}

/**
 * Viva results for the period. Kept completely separate from the quiz numbers: it only ever looks at completed
 * vivas, and an abandoned or unfinished viva never counts.
 */
export function vivaStats(facts: readonly VivaFact[]): VivaProgress {
  const ordered = [...facts].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (ordered.length === 0) return { sessionsCompleted: 0, averageScore: null, bestScore: null, recentScore: null, dimensions: null, bySubject: [], recent: [] };
  const avg = (list: readonly number[]) => round1(list.reduce((s, v) => s + v, 0) / list.length);
  const dim = (pick: (f: VivaFact) => number | null) => {
    const v = ordered.map(pick).filter((x): x is number => x !== null);
    return v.length ? round1((v.reduce((s, x) => s + x, 0) / v.length) * 10) : 0;
  };
  const subjects = new Names();
  const by = new Map<string, number[]>();
  for (const f of ordered) {
    const k = subjects.key(f.subject);
    by.set(k, [...(by.get(k) ?? []), f.score]);
  }
  return {
    sessionsCompleted: ordered.length,
    averageScore: avg(ordered.map((f) => f.score)),
    bestScore: Math.max(...ordered.map((f) => f.score)),
    recentScore: ordered[ordered.length - 1]!.score,
    dimensions: { correctness: dim((f) => f.c), completeness: dim((f) => f.p), clarity: dim((f) => f.l), confidence: dim((f) => f.f) },
    bySubject: [...by].map(([k, scores]) => ({ subject: subjects.name(k), sessions: scores.length, averageScore: avg(scores) })).sort((a, b) => b.sessions - a.sessions || b.averageScore - a.averageScore || a.subject.localeCompare(b.subject)).slice(0, 8),
    recent: ordered.slice(-5).reverse().map((f) => ({ id: f.id, subject: f.subject, topic: f.topic, score: f.score, date: f.date })),
  };
}
