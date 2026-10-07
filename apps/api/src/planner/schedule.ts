import { PLANNER_LIMITS, type ActivityType, type KnowledgeLevel, type PreferredTime, type Priority } from "@copilot/shared";
import { addDays, dateRange, isoWeekday } from "./dates.js";

/**
 * The deterministic part of the planner. The AI decides WHAT to study (topics, their order and how
 * long a first session on each should be); this code decides WHEN, so a plan can never put a session
 * after the exam, on a day the student did not choose, or over their daily time.
 */

export interface TopicItem {
  subject: string;
  topic: string;
  /** Suggested length of a first session on this topic, minutes. */
  minutes: number;
  priority: Priority;
  /** From the student's real quiz results: gets extra revision. */
  weak: boolean;
}

export interface ScheduleInput {
  /** First day that may hold a session (the student's today). */
  startDate: string;
  /** No sessions on or after this day. */
  examDate: string;
  /** ISO weekdays the student studies on. */
  studyDays: number[];
  minutesPerDay: number;
  preferredTime: PreferredTime;
  level: KnowledgeLevel;
  /** Topics in the order they should be studied within each subject. */
  topics: TopicItem[];
}

export interface PlannedSession {
  date: string;
  startTime: string | null;
  durationMinutes: number;
  subject: string;
  topic: string;
  activityType: ActivityType;
  priority: Priority;
}

export interface Schedule {
  sessions: PlannedSession[];
  /** "Subject: topic" entries that did not fit before the exam. */
  unscheduled: string[];
}

export class PlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanInputError";
  }
}

const WEIGHT: Record<Priority, number> = { high: 3, medium: 2, low: 1 };
const START_HOUR: Record<PreferredTime, number | null> = { morning: 8, afternoon: 14, evening: 18, any: null };
const BREAK_MINUTES = 10;

const floor5 = (n: number) => Math.floor(n / 5) * 5;

/** The days a plan may use: from start to the day before the exam, on the chosen weekdays. */
export function studyDates(startDate: string, examDate: string, studyDays: number[]): string[] {
  if (examDate <= startDate) return [];
  const last = addDays(examDate, -1);
  const allowed = new Set(studyDays);
  return dateRange(startDate, last).filter((d) => allowed.has(isoWeekday(d))).slice(0, PLANNER_LIMITS.maxPlanDays);
}

/** How a study day is split: e.g. 30 min -> 1x30, 120 -> 2x60, 180 -> 2x90, 240 -> 3x80. */
export function daySlots(minutesPerDay: number): { count: number; length: number } {
  const count = Math.min(PLANNER_LIMITS.maxSessionsPerDay, Math.max(1, Math.ceil(minutesPerDay / 90)));
  const length = Math.min(PLANNER_LIMITS.maxSessionMinutes, Math.max(PLANNER_LIMITS.minSessionMinutes, floor5(minutesPerDay / count)));
  return { count, length };
}

/** First-pass activities for a topic, by knowledge level. Revision comes later, spaced out. */
function firstPass(level: KnowledgeLevel): ActivityType[] {
  if (level === "advanced") return ["practice"];
  return ["learn", "practice"];
}

interface Unit {
  item: TopicItem;
  activity: ActivityType;
}

/** Smooth weighted round-robin over subjects, so high-priority subjects get more (but not all) of the time. */
function interleave(bySubject: Map<string, Unit[]>, priorities: Map<string, Priority>): Unit[] {
  const queues = [...bySubject.entries()].map(([subject, units]) => ({ subject, units: [...units], weight: WEIGHT[priorities.get(subject) ?? "medium"], current: 0 }));
  const out: Unit[] = [];
  const total = queues.reduce((n, q) => n + q.weight, 0);
  while (queues.some((q) => q.units.length > 0)) {
    for (const q of queues) q.current += q.units.length > 0 ? q.weight : 0;
    const next = queues.filter((q) => q.units.length > 0).sort((a, b) => b.current - a.current)[0]!;
    next.current -= total;
    out.push(next.units.shift()!);
  }
  return out;
}

export function buildSchedule(input: ScheduleInput): Schedule {
  const days = studyDates(input.startDate, input.examDate, input.studyDays);
  if (days.length === 0) throw new PlanInputError("There are no study days between today and your exam on the days you chose. Pick more days or a later exam date.");
  if (input.topics.length === 0) throw new PlanInputError("There is nothing to schedule: no topics were found for your subjects.");

  const { count: perDay, length } = daySlots(input.minutesPerDay);
  const finalDays = days.length >= 4 ? Math.max(1, Math.round(days.length * 0.15)) : 0;
  const mainDays = days.slice(0, days.length - finalDays);
  const lastDays = days.slice(days.length - finalDays);
  const capacity = mainDays.length * perDay;

  const priorities = new Map(input.topics.map((t) => [t.subject, t.priority]));
  const subjectOrder = [...new Set(input.topics.map((t) => t.subject))];

  // 1) What must be studied. If two passes per topic do not fit, every topic gets one; if even that
  //    does not fit, the lowest-priority topics are left out and REPORTED, never silently dropped.
  let passes = firstPass(input.level);
  if (input.topics.length * passes.length > capacity) passes = [passes[0]!];
  let included = [...input.topics];
  const unscheduled: string[] = [];
  if (included.length > Math.max(capacity, 1)) {
    const ranked = [...included].sort((a, b) => WEIGHT[b.priority] - WEIGHT[a.priority] || Number(b.weak) - Number(a.weak));
    const keep = new Set(ranked.slice(0, Math.max(capacity, 1)));
    for (const t of included) if (!keep.has(t)) unscheduled.push(`${t.subject}: ${t.topic}`);
    included = included.filter((t) => keep.has(t));
  }

  const bySubject = new Map<string, Unit[]>(subjectOrder.map((s) => [s, []]));
  for (const item of included) {
    for (const activity of passes) bySubject.get(item.subject)!.push({ item, activity });
    if (item.weak && passes.length > 1) bySubject.get(item.subject)!.push({ item, activity: "revision" });
  }
  const queue = interleave(bySubject, priorities);

  // 2) Spaced revision fills the rest of the main phase (weak and high-priority topics first), with
  //    a short quiz now and then to check what has been learned.
  const revisionOrder = [...included].sort((a, b) => Number(b.weak) - Number(a.weak) || WEIGHT[b.priority] - WEIGHT[a.priority]);
  let revisionCursor = 0;
  let fillerCount = 0;
  const nextFiller = (): Unit => {
    const item = revisionOrder[revisionCursor++ % revisionOrder.length]!;
    fillerCount++;
    return { item, activity: fillerCount % 4 === 0 ? "quiz" : "revision" };
  };

  const sessions: PlannedSession[] = [];
  const usedByDay = new Map<string, Set<string>>();
  const keyOf = (u: Unit) => `${u.item.subject}|${u.item.topic}|${u.activity}`;
  /**
   * Puts a unit in a slot. The same topic+activity never appears twice on one day: a repeat becomes a
   * different kind of session on that topic, or the slot is left free (free time is fine; a duplicate is not).
   */
  const place = (date: string, slot: number, unit: Unit): boolean => {
    const used = usedByDay.get(date) ?? new Set<string>();
    usedByDay.set(date, used);
    const variants: ActivityType[] = [unit.activity, ...(["revision", "practice", "quiz"] as const).filter((a) => a !== unit.activity)];
    const activity = variants.find((a) => !used.has(keyOf({ ...unit, activity: a })));
    if (!activity) return false;
    used.add(keyOf({ ...unit, activity }));
    const start = START_HOUR[input.preferredTime];
    const startMinutes = start === null ? null : start * 60 + slot * (length + BREAK_MINUTES);
    sessions.push({
      date,
      startTime: startMinutes === null || startMinutes >= 24 * 60 ? null : `${String(Math.floor(startMinutes / 60)).padStart(2, "0")}:${String(startMinutes % 60).padStart(2, "0")}`,
      durationMinutes: length,
      subject: unit.item.subject,
      topic: unit.item.topic,
      activityType: activity,
      priority: unit.item.priority,
    });
    return true;
  };

  for (const date of mainDays) {
    for (let slot = 0; slot < perDay; slot++) {
      let unit = queue.shift() ?? nextFiller();
      // Prefer something else waiting over a second session on the same topic today.
      const used = usedByDay.get(date);
      if (used && [...used].some((k) => k.startsWith(`${unit.item.subject}|${unit.item.topic}|`)) && queue.length > 0) {
        queue.push(unit);
        unit = queue.shift()!;
      }
      place(date, slot, unit);
    }
  }

  // 3) Final phase before the exam: one practice test, then revision of what matters most.
  lastDays.forEach((date, dayIndex) => {
    for (let slot = 0; slot < perDay; slot++) {
      if (dayIndex === 0 && slot === 0 && length >= 30) {
        const top = revisionOrder[0]!;
        place(date, slot, { item: { ...top, topic: "Full practice test", subject: top.subject }, activity: "mock_test" });
        continue;
      }
      place(date, slot, { item: revisionOrder[(dayIndex * perDay + slot) % revisionOrder.length]!, activity: "revision" });
    }
  });

  return { sessions, unscheduled };
}

export interface ScheduleRules {
  startDate: string;
  examDate: string;
  minutesPerDay: number;
  subjects: string[];
}

/**
 * Independent check of a finished schedule (also used when rescheduling). Returns every problem found;
 * an empty list means the schedule is valid. Any non-empty result stops the plan from being saved.
 */
export function validateSchedule(sessions: readonly PlannedSession[], rules: ScheduleRules): string[] {
  const problems: string[] = [];
  const subjects = new Set(rules.subjects.map((s) => s.toLowerCase()));
  const perDay = new Map<string, { minutes: number; count: number }>();
  const seen = new Set<string>();
  const dateOk = /^\d{4}-\d{2}-\d{2}$/;
  sessions.forEach((s, i) => {
    const where = `session ${i + 1}`;
    if (!dateOk.test(s.date) || Number.isNaN(Date.parse(`${s.date}T00:00:00Z`))) problems.push(`${where}: invalid date`);
    if (s.date < rules.startDate) problems.push(`${where}: before the plan starts`);
    if (s.date >= rules.examDate) problems.push(`${where}: on or after the exam date`);
    if (!Number.isInteger(s.durationMinutes) || s.durationMinutes < PLANNER_LIMITS.minSessionMinutes || s.durationMinutes > PLANNER_LIMITS.maxSessionMinutes) problems.push(`${where}: invalid duration`);
    if (!s.subject.trim() || !subjects.has(s.subject.toLowerCase())) problems.push(`${where}: subject is not one of the plan's subjects`);
    if (!s.topic.trim()) problems.push(`${where}: missing topic`);
    const key = `${s.date}|${s.subject}|${s.topic}|${s.activityType}`;
    if (seen.has(key)) problems.push(`${where}: duplicate session`);
    seen.add(key);
    const day = perDay.get(s.date) ?? { minutes: 0, count: 0 };
    day.minutes += s.durationMinutes;
    day.count++;
    perDay.set(s.date, day);
  });
  for (const [date, day] of perDay) {
    if (day.minutes > rules.minutesPerDay) problems.push(`${date}: ${day.minutes} minutes planned, more than the ${rules.minutesPerDay} available`);
    if (day.count > PLANNER_LIMITS.maxSessionsPerDay) problems.push(`${date}: too many sessions in one day`);
  }
  return problems;
}
