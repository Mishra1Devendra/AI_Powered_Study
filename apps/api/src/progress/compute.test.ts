import { describe, expect, it } from "vitest";
import { masteryLevel, PROGRESS_THRESHOLDS } from "@copilot/shared";
import {
  boundsFor,
  classifySession,
  quizStats,
  recentActivity,
  streakStats,
  studyTimeStats,
  topicAnalysis,
  vivaStats,
  type AttemptFact,
  type BreakdownFact,
  type VivaFact,
  type SessionFact,
} from "./compute.js";

const TODAY = "2026-10-15"; // a Thursday

let n = 0;
const session = (over: Partial<SessionFact> = {}): SessionFact => ({
  id: `s${++n}`,
  date: TODAY,
  completedDate: null,
  status: "planned",
  durationMinutes: 30,
  subject: "Physics",
  topic: "Forces",
  activityType: "learn",
  planStatus: "active",
  ...over,
});
const done = (day: string, over: Partial<SessionFact> = {}) => session({ date: day, completedDate: day, status: "completed", ...over });

const attempt = (over: Partial<AttemptFact> = {}): AttemptFact => ({
  attemptId: `a${++n}`,
  quizId: `q${n}`,
  quizTitle: "Quiz",
  subject: "Physics",
  at: new Date("2026-10-10T10:00:00Z"),
  date: "2026-10-10",
  percentage: 70,
  ...over,
});
const rows = (attemptId: string, topic: string | null, correct: number, total: number, over: Partial<BreakdownFact> = {}): BreakdownFact => ({
  attemptId,
  topic,
  difficulty: "medium",
  total,
  answered: total,
  correct,
  ...over,
});

describe("range bounds", () => {
  it("covers today and the days before it, with an equal-length previous period", () => {
    expect(boundsFor("7d", TODAY)).toEqual({ from: "2026-10-09", to: TODAY, prevFrom: "2026-10-02", prevTo: "2026-10-08" });
    expect(boundsFor("30d", TODAY)).toMatchObject({ from: "2026-09-16", prevFrom: "2026-08-17", prevTo: "2026-09-15" });
    expect(boundsFor("90d", TODAY).from).toBe("2026-07-18");
  });
  it("all time has no start and nothing to compare with", () => {
    expect(boundsFor("all", TODAY)).toEqual({ from: null, to: TODAY, prevFrom: null, prevTo: null });
  });
});

describe("masteryLevel (documented thresholds)", () => {
  const { minQuestionsForMastery: min, strongAtOrAbove, weakBelow } = PROGRESS_THRESHOLDS;
  it("needs enough questions before it labels anything", () => {
    expect(masteryLevel(min - 1, min - 1)).toBe("insufficient");
    expect(masteryLevel(0, 0)).toBe("insufficient");
    expect(masteryLevel(min, min)).toBe("strong");
  });
  it("splits strong / needs practice / weak at the documented lines", () => {
    expect(masteryLevel(strongAtOrAbove, 100)).toBe("strong");
    expect(masteryLevel(strongAtOrAbove - 1, 100)).toBe("needs_practice");
    expect(masteryLevel(weakBelow, 100)).toBe("needs_practice");
    expect(masteryLevel(weakBelow - 1, 100)).toBe("weak");
    expect(masteryLevel(0, min)).toBe("weak");
  });
});

describe("session classification", () => {
  it("counts only explicit completions as completed", () => {
    expect(classifySession(session({ status: "completed" }), TODAY)).toBe("completed");
    for (const status of ["planned", "in_progress"] as const) expect(classifySession(session({ status }), TODAY)).toBe("upcoming");
  });
  it("a planned session whose day passed is missed - on the active plan only", () => {
    expect(classifySession(session({ date: "2026-10-10" }), TODAY)).toBe("missed");
    expect(classifySession(session({ date: "2026-10-10", planStatus: "archived" }), TODAY)).toBeNull();
    expect(classifySession(session({ date: "2026-10-20", planStatus: "archived" }), TODAY)).toBeNull();
  });
  it("keeps explicit decisions from any plan, and ignores rescheduled originals", () => {
    expect(classifySession(session({ status: "skipped", planStatus: "archived" }), TODAY)).toBe("skipped");
    expect(classifySession(session({ status: "missed", planStatus: "archived" }), TODAY)).toBe("missed");
    expect(classifySession(session({ status: "rescheduled" }), TODAY)).toBeNull();
  });
});

describe("study time", () => {
  const b = boundsFor("7d", TODAY);
  const sessions = [
    done("2026-10-15", { durationMinutes: 45, subject: "Physics", activityType: "learn" }),
    done("2026-10-15", { durationMinutes: 30, subject: "physics ", activityType: "practice" }),
    done("2026-10-13", { durationMinutes: 60, subject: "Maths", activityType: "learn" }),
    done("2026-10-05", { durationMinutes: 90 }), // before the 7-day window, inside the previous one
    session({ status: "skipped", date: "2026-10-14" }),
    session({ date: "2026-10-12" }), // planned, day passed -> missed
    session({ date: "2026-10-20" }), // upcoming
    session({ status: "rescheduled", date: "2026-10-14" }),
  ];
  const stats = studyTimeStats(sessions, b, TODAY, "7d");

  it("adds up study time, sessions and rates from completed sessions only", () => {
    expect(stats.totalMinutes).toBe(135);
    expect(stats).toMatchObject({ completedSessions: 3, skippedSessions: 1, missedSessions: 1, upcomingSessions: 1, activeDays: 2 });
    expect(stats.completionRate).toBe(60); // 3 of (3 + 1 + 1)
    expect(stats.averageMinutesPerActiveDay).toBe(68);
  });
  it("compares with the previous period only when it had study time", () => {
    expect(stats.previousMinutes).toBe(90);
    expect(studyTimeStats([done("2026-10-14")], b, TODAY, "7d").previousMinutes).toBeNull();
    expect(studyTimeStats(sessions, boundsFor("all", TODAY), TODAY, "all").previousMinutes).toBeNull();
  });
  it("aggregates per day, zero-filled across the whole period", () => {
    expect(stats.granularity).toBe("day");
    expect(stats.byPeriod.map((p) => p.start)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(stats.byPeriod.map((p) => p.minutes)).toEqual([0, 0, 0, 0, 60, 0, 75]);
  });
  it("groups subjects regardless of capitalisation and spacing, biggest first", () => {
    expect(stats.bySubject).toEqual([
      { subject: "Physics", minutes: 75, sessions: 2 },
      { subject: "Maths", minutes: 60, sessions: 1 },
    ]);
  });
  it("splits time by the planner's own activity types", () => {
    expect(stats.byActivity).toEqual([
      { activityType: "learn", minutes: 105, sessions: 2, percentage: 77.8 },
      { activityType: "practice", minutes: 30, sessions: 1, percentage: 22.2 },
    ]);
  });
  it("counts a catch-up session on the day it was done, not the day it was scheduled", () => {
    const late = session({ date: "2026-10-01", completedDate: "2026-10-15", status: "completed", durationMinutes: 30 });
    expect(studyTimeStats([late], b, TODAY, "7d").totalMinutes).toBe(30);
    expect(studyTimeStats([late], boundsFor("7d", "2026-10-08"), "2026-10-08", "7d").totalMinutes).toBe(0);
  });
  it("90 days and all time use weekly bars starting on Monday", () => {
    const week = studyTimeStats(sessions, boundsFor("90d", TODAY), TODAY, "90d");
    expect(week.granularity).toBe("week");
    expect(week.byPeriod.at(-1)).toEqual({ start: "2026-10-12", minutes: 135 - 0, sessions: 3 });
    expect(week.byPeriod.find((p) => p.start === "2026-10-05")).toMatchObject({ minutes: 90 });
    const all = studyTimeStats(sessions, boundsFor("all", TODAY), TODAY, "all");
    expect(all.byPeriod[0]!.start).toBe("2026-10-05");
  });
  it("has no rates or averages without data (never a made-up zero percent)", () => {
    const empty = studyTimeStats([], b, TODAY, "7d");
    expect(empty).toMatchObject({ totalMinutes: 0, completionRate: null, averageMinutesPerActiveDay: null, byActivity: [], bySubject: [] });
    expect(studyTimeStats([], boundsFor("all", TODAY), TODAY, "all").byPeriod).toEqual([]);
  });
});

describe("streaks", () => {
  it("is empty (not zero) with no completed session", () => {
    expect(streakStats([], TODAY)).toEqual({ current: null, longest: null, studyDays: 0, lastStudyDate: null });
  });
  it("one study day today is a streak of 1", () => {
    expect(streakStats([TODAY], TODAY)).toMatchObject({ current: 1, longest: 1, studyDays: 1 });
  });
  it("counts consecutive days ending today", () => {
    expect(streakStats(["2026-10-13", "2026-10-14", "2026-10-15"], TODAY)).toMatchObject({ current: 3, longest: 3 });
  });
  it("stays alive until the end of the day after the last study day, then breaks", () => {
    expect(streakStats(["2026-10-13", "2026-10-14"], TODAY).current).toBe(2); // last was yesterday: today is still to come
    expect(streakStats(["2026-10-12", "2026-10-13"], TODAY).current).toBe(0); // two days ago: broken
  });
  it("a gap resets the current streak but keeps the longest", () => {
    const s = streakStats(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-14", "2026-10-15"], TODAY);
    expect(s).toMatchObject({ current: 2, longest: 4, studyDays: 6, lastStudyDate: TODAY });
  });
  it("several sessions on one day and unsorted input make no difference", () => {
    expect(streakStats([TODAY, "2026-10-14", TODAY, "2026-10-14", "2026-10-13"], TODAY)).toMatchObject({ current: 3, studyDays: 3 });
  });
  it("skipped-only days never create a streak: only completed sessions supply the dates", () => {
    const sessions = [session({ status: "skipped", date: TODAY }), session({ status: "planned", date: TODAY }), done("2026-10-14")];
    const dates = sessions.filter((s) => s.status === "completed").map((s) => s.completedDate!);
    expect(streakStats(dates, TODAY)).toMatchObject({ current: 1, studyDays: 1 });
    expect(streakStats([], TODAY).current).toBeNull();
  });
  it("works across month and year ends and daylight-saving changes", () => {
    expect(streakStats(["2026-12-30", "2026-12-31", "2027-01-01"], "2027-01-01").current).toBe(3);
    expect(streakStats(["2026-03-28", "2026-03-29", "2026-03-30"], "2026-03-30").current).toBe(3);
  });
});

describe("quiz statistics", () => {
  const a1 = attempt({ attemptId: "a1", quizId: "qa", percentage: 50, at: new Date("2026-10-08T10:00:00Z"), date: "2026-10-08" });
  const a2 = attempt({ attemptId: "a2", quizId: "qa", percentage: 80, at: new Date("2026-10-12T10:00:00Z"), date: "2026-10-12" });
  const a3 = attempt({ attemptId: "a3", quizId: "qb", percentage: 90, at: new Date("2026-10-14T10:00:00Z"), date: "2026-10-14" });
  const breakdown = [
    rows("a1", "Heat", 2, 5, { answered: 4 }),
    rows("a2", "Heat", 4, 5),
    rows("a3", "Waves", 4, 5, { difficulty: "hard" }),
  ];
  const stats = quizStats([a3, a1, a2], [attempt({ percentage: 40 })], breakdown, 3);

  it("average, highest, lowest and the latest score", () => {
    expect(stats).toMatchObject({ attemptsCompleted: 3, quizzesCompleted: 2, quizzesAttempted: 3, averageScore: 73.3, highestScore: 90, lowestScore: 50, recentScore: 90, previousAverageScore: 40 });
  });
  it("question accuracy: unanswered questions are not correct, and are reported separately", () => {
    expect(stats).toMatchObject({ questions: 15, correct: 10, incorrect: 4, unanswered: 1, accuracy: 66.7 });
  });
  it("trend is oldest first, with the real dates", () => {
    expect(stats.trend.map((t) => [t.date, t.percentage])).toEqual([["2026-10-08", 50], ["2026-10-12", 80], ["2026-10-14", 90]]);
  });
  it("splits accuracy by difficulty, and withholds it when there are too few questions", () => {
    expect(stats.byDifficulty).toEqual([
      { difficulty: "medium", questions: 10, correct: 6, accuracy: 60 },
      { difficulty: "hard", questions: 5, correct: 4, accuracy: 80 },
    ]);
    expect(quizStats([a1], [], [rows("a1", "Heat", 1, 3, { difficulty: "easy" })], 1).byDifficulty[0]!.accuracy).toBeNull();
  });
  it("no finished attempts means no numbers at all", () => {
    expect(quizStats([], [], [], 2)).toMatchObject({ attemptsCompleted: 0, averageScore: null, highestScore: null, lowestScore: null, recentScore: null, accuracy: null, questions: 0, trend: [], quizzesAttempted: 2 });
  });
  it("keeps only the latest 30 points", () => {
    const many = Array.from({ length: 40 }, (_, i) => attempt({ percentage: i, at: new Date(Date.UTC(2026, 8, 1 + (i % 28), i)), date: "2026-09-01" }));
    expect(quizStats(many, [], [], 0).trend).toHaveLength(30);
  });
});

describe("topic analysis", () => {
  const b = boundsFor("all", TODAY);
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10));
  const attempts = [
    attempt({ attemptId: "t1", quizId: "q1", subject: "Physics", at: at(1), date: "2026-10-01" }),
    attempt({ attemptId: "t2", quizId: "q2", subject: "Physics", at: at(5), date: "2026-10-05" }),
    attempt({ attemptId: "t3", quizId: "q3", subject: null, at: at(9), date: "2026-10-09" }),
  ];
  const breakdown = [
    rows("t1", "Thermodynamics", 2, 5), // 40% earlier
    rows("t2", "Thermodynamics", 4, 5), // 80% later
    rows("t1", "Electrostatics", 1, 5),
    rows("t2", "Electrostatics", 1, 5), // 20% overall: weak, flat
    rows("t3", "Organic chemistry", 2, 3), // too few questions
    rows("t3", null, 1, 1), // no known topic
  ];
  const result = topicAnalysis([], b, TODAY, attempts, breakdown);
  const topic = (name: string) => result.topics.find((t) => t.topic === name)!;

  it("labels a topic with enough data as strong, needs practice or weak", () => {
    expect(topic("Thermodynamics")).toMatchObject({ correct: 6, total: 10, accuracy: 60, level: "needs_practice", subject: "Physics" });
    expect(topic("Electrostatics")).toMatchObject({ accuracy: 20, level: "weak" });
  });
  it("gives no percentage or label to a topic without enough data", () => {
    expect(topic("Organic chemistry")).toMatchObject({ total: 3, accuracy: null, level: "insufficient", trend: null, subject: null });
  });
  it("never invents a topic for questions without one", () => {
    expect(result.topics.map((t) => t.topic)).not.toContain(null);
    expect(result.topics).toHaveLength(3);
  });
  it("lists weak areas weakest first and counts each level", () => {
    expect(result.weakAreas.map((t) => t.topic)).toEqual(["Electrostatics"]);
    expect(result.summary).toMatchObject({ studied: 3, withEnoughData: 2, strong: 0, needsPractice: 1, weak: 1 });
    expect(result.topics.map((t) => t.topic)).toEqual(["Electrostatics", "Thermodynamics", "Organic chemistry"]);
  });
  it("finds an improving topic from real history", () => {
    expect(topic("Thermodynamics").trend).toEqual({ previous: 40, recent: 80, delta: 40 });
    expect(result.improving.map((t) => t.topic)).toEqual(["Thermodynamics"]);
    expect(result.improvementComparable).toBe(true);
  });
  it("does not claim improvement without enough history", () => {
    const one = topicAnalysis([], b, TODAY, [attempts[0]!], [rows("t1", "Heat", 2, 5)]);
    expect(one.improving).toEqual([]);
    expect(one.improvementComparable).toBe(false);
    // Earlier attempts with fewer than 3 questions cannot be compared either.
    const thin = topicAnalysis([], b, TODAY, attempts.slice(0, 2), [rows("t1", "Heat", 1, 2), rows("t2", "Heat", 4, 5)]);
    expect(thin.topics[0]!.trend).toBeNull();
  });
  it("a small gain is not 'improving'", () => {
    const flat = topicAnalysis([], b, TODAY, attempts.slice(0, 2), [rows("t1", "Heat", 3, 5), rows("t2", "Heat", 3, 5)]);
    expect(flat.topics[0]!.trend).toEqual({ previous: 60, recent: 60, delta: 0 });
    expect(flat.improving).toEqual([]);
    expect(flat.improvementComparable).toBe(true);
  });
  it("merges topic spellings and repeated attempts of the same quiz", () => {
    const merged = topicAnalysis([], b, TODAY, attempts.slice(0, 2), [rows("t1", "Heat", 3, 5), rows("t2", " heat ", 4, 5)]);
    expect(merged.topics).toHaveLength(1);
    expect(merged.topics[0]).toMatchObject({ topic: "Heat", correct: 7, total: 10 });
  });

  describe("subjects", () => {
    it("combines study time and quiz accuracy under one subject", () => {
      const sessions = [done("2026-10-14", { subject: "physics", durationMinutes: 40 }), done("2026-10-13", { subject: "Chemistry", durationMinutes: 20 })];
      const r = topicAnalysis(sessions, b, TODAY, attempts, breakdown);
      const physics = r.subjects.find((s) => s.subject.toLowerCase() === "physics")!;
      expect(physics).toMatchObject({ studyMinutes: 40, completedSessions: 1, quizzes: 2, questions: 20, accuracy: 40, level: "weak" });
      expect(physics.topics.map((t) => t.topic)).toEqual(["Electrostatics", "Thermodynamics"]);
      expect(r.subjects.find((s) => s.subject === "Chemistry")).toMatchObject({ studyMinutes: 20, questions: 0, accuracy: null, level: "insufficient", topics: [] });
    });
    it("a subject only appears when there is real data for it", () => {
      expect(topicAnalysis([], b, TODAY, [], []).subjects).toEqual([]);
    });
  });

  it("topics studied also counts completed sessions (but not the placeholder practice test)", () => {
    const sessions = [done("2026-10-14", { topic: "Optics" }), done("2026-10-14", { topic: "Full practice test", activityType: "mock_test" }), session({ topic: "Never done" })];
    expect(topicAnalysis(sessions, b, TODAY, attempts, breakdown).summary.studied).toBe(4);
  });

  it("limits to the selected period", () => {
    const week = topicAnalysis([done("2026-09-01", { topic: "Old" })], boundsFor("7d", TODAY), TODAY, [], []);
    expect(week.summary.studied).toBe(0);
  });
});

describe("recent activity", () => {
  it("merges sessions and quizzes, newest first, with real titles and links", () => {
    const events = recentActivity(
      [
        { id: "s1", status: "completed", at: new Date("2026-10-15T09:00:00Z"), date: "2026-10-15", subject: "Physics", topic: "Heat", durationMinutes: 45 },
        { id: "s2", status: "skipped", at: new Date("2026-10-13T09:00:00Z"), date: "2026-10-13", subject: "Maths", topic: "Integration", durationMinutes: 30 },
      ],
      [attempt({ attemptId: "a9", quizTitle: "Maths quiz", percentage: 82, at: new Date("2026-10-14T09:00:00Z"), date: "2026-10-14" })],
      12,
    );
    expect(events.map((e) => [e.type, e.title, e.detail])).toEqual([
      ["session_completed", "Completed Physics — Heat", "45 min"],
      ["quiz_completed", "Completed quiz — Maths quiz", "82%"],
      ["session_skipped", "Skipped Maths — Integration", "30 min"],
    ]);
    expect(events[0]!.href).toBe("/study-plan?session=s1");
    expect(events[1]!.href).toBe("/quiz/attempt/a9/result");
  });
  it("is empty without activity, and respects the limit", () => {
    expect(recentActivity([], [], 12)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, status: "completed" as const, at: new Date(Date.UTC(2026, 9, 1, i)), date: "2026-10-01", subject: "A", topic: "B", durationMinutes: 30 }));
    expect(recentActivity(many, [], 12)).toHaveLength(12);
  });
});

describe("viva statistics (separate from quizzes)", () => {
  const viva = (id: string, score: number, day: number, over: Partial<VivaFact> = {}): VivaFact => ({
    id,
    subject: "Chemistry",
    topic: "Rates",
    score,
    date: `2026-10-${String(day).padStart(2, "0")}`,
    at: new Date(Date.UTC(2026, 9, day, 10)),
    c: 8,
    p: 6,
    l: 7,
    f: 5,
    ...over,
  });
  it("is empty (nulls, not zeros) with no completed viva", () => {
    expect(vivaStats([])).toEqual({ sessionsCompleted: 0, averageScore: null, bestScore: null, recentScore: null, dimensions: null, bySubject: [], recent: [] });
  });
  it("average, best, latest, dimension percentages and subjects", () => {
    const s = vivaStats([viva("a", 60, 3), viva("b", 90, 10, { subject: "physics", c: 10, p: 10, l: 10, f: 10 }), viva("c", 75, 7, { subject: "Physics" })]);
    expect(s).toMatchObject({ sessionsCompleted: 3, averageScore: 75, bestScore: 90, recentScore: 90 });
    expect(s.dimensions).toEqual({ correctness: 86.7, completeness: 73.3, clarity: 80, confidence: 66.7 });
    expect(s.bySubject).toEqual([
      { subject: "Physics", sessions: 2, averageScore: 82.5 }, // the first spelling seen is shown
      { subject: "Chemistry", sessions: 1, averageScore: 60 },
    ]);
    expect(s.recent.map((r) => r.id)).toEqual(["b", "c", "a"]); // newest first
  });
  it("keeps only the latest five", () => {
    expect(vivaStats(Array.from({ length: 8 }, (_, i) => viva(`v${i}`, 50, i + 1))).recent).toHaveLength(5);
  });
});
