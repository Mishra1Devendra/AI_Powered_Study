import { z } from "zod";
import { activityTypeSchema } from "./planner.js";

/**
 * PROGRESS & ANALYTICS - definitions and contracts, shared by the API (which calculates everything)
 * and the web app (which only displays it).
 *
 * All numbers are calculated from the student's own records: completed study sessions and
 * submitted quiz attempts. Nothing is estimated, and a section with too little data says so
 * instead of showing a number. Dates are the student's LOCAL calendar days (profile timezone).
 *
 * DEFINITIONS
 * - Completed session: a study session whose status is "completed" (the student pressed Mark complete).
 *   A planned, started, skipped, missed or rescheduled session is never counted as completed.
 * - Study time: the sum of the planned length of completed sessions. The app does not time sessions,
 *   so this is the length the student committed to, not a stopwatch reading.
 * - Study day: a local calendar day on which at least one session was completed (the completion time
 *   decides the day, so catching up on an old session counts for the day it was actually done).
 * - Current streak: consecutive study days ending today. If today has no completed session yet, a streak
 *   that ended yesterday is still alive (the day is not over). Otherwise the streak is 0.
 * - Longest streak: the longest run of consecutive study days, over all time.
 * - Finished quiz attempt: an attempt with status "submitted" or "expired" (it has a score). In-progress
 *   attempts and quizzes that failed to generate are never counted.
 * - Average quiz score: the mean of the percentage of the finished attempts in the period.
 * - Quiz accuracy / topic accuracy: correct answers / questions, over finished attempts. A question the
 *   student left unanswered counts as not correct (same rule as the quiz score itself). Every attempt
 *   counts, so retaking a quiz counts its questions again.
 * - Completion rate: completed / (completed + skipped + missed) sessions in the period.
 * - Missed session: marked "missed" by the student, or still planned/in progress after its day has
 *   passed. The second kind is only counted for the ACTIVE plan (a replaced plan's untouched sessions
 *   are not the student's misses).
 * - Insufficient data: fewer than MIN_QUESTIONS_FOR_MASTERY answered-or-unanswered questions. No
 *   percentage is turned into a label below that.
 * - Weak / Needs practice / Strong: the thresholds below. They are simple, documented cut-offs, not a
 *   validated measure of ability, and no overall "ability score" is ever calculated.
 * - Improving topic: the recent attempts (at least MIN_QUESTIONS_PER_TREND_WINDOW questions) are at least
 *   IMPROVING_DELTA percentage points better than the earlier ones (also at least that many questions).
 */
export const PROGRESS_THRESHOLDS = {
  /** Fewest questions before a topic or subject gets a label. */
  minQuestionsForMastery: 5,
  /** Accuracy at or above this is "Strong". */
  strongAtOrAbove: 75,
  /** Accuracy below this is "Weak"; from here up to the strong line is "Needs practice". */
  weakBelow: 50,
  /** Questions needed on each side of an improvement comparison. */
  minQuestionsPerTrendWindow: 3,
  /** Percentage points of gain that count as improving. */
  improvingDelta: 10,
} as const;

export const PROGRESS_RANGES = ["7d", "30d", "90d", "all"] as const;
export const progressRangeSchema = z.enum(PROGRESS_RANGES);
export type ProgressRange = z.infer<typeof progressRangeSchema>;
export const RANGE_LABEL: Record<ProgressRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };
export const progressQuerySchema = z.object({ range: progressRangeSchema.default("30d") });

export const MASTERY_LEVELS = ["strong", "needs_practice", "weak", "insufficient"] as const;
export const masteryLevelSchema = z.enum(MASTERY_LEVELS);
export type MasteryLevel = z.infer<typeof masteryLevelSchema>;
export const MASTERY_LABEL: Record<MasteryLevel, string> = {
  strong: "Strong",
  needs_practice: "Needs Practice",
  weak: "Weak",
  insufficient: "Insufficient Data",
};

/** The one place a percentage becomes a label. Used by the API; the web app only displays the result. */
export function masteryLevel(correct: number, total: number): MasteryLevel {
  if (total < PROGRESS_THRESHOLDS.minQuestionsForMastery) return "insufficient";
  const pct = (correct / total) * 100;
  return pct >= PROGRESS_THRESHOLDS.strongAtOrAbove ? "strong" : pct < PROGRESS_THRESHOLDS.weakBelow ? "weak" : "needs_practice";
}

const minutes = z.number().int().min(0);
const percent = z.number().min(0).max(100);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoTime = z.string().datetime({ offset: true });

export const studyPeriodSchema = z.object({ start: localDate, minutes, sessions: z.number().int().min(0) });
export const studyTimeSchema = z.object({
  totalMinutes: minutes,
  /** The same amount of time just before this period; null for "All time" or when it had no study time. */
  previousMinutes: minutes.nullable(),
  completedSessions: z.number().int().min(0),
  skippedSessions: z.number().int().min(0),
  missedSessions: z.number().int().min(0),
  /** Still to come (active plan). Not part of the completion rate. */
  upcomingSessions: z.number().int().min(0),
  completionRate: percent.nullable(),
  activeDays: z.number().int().min(0),
  /** Average over the days that had a completed session (null when there were none). */
  averageMinutesPerActiveDay: z.number().int().min(0).nullable(),
  /** "day" bars for 7 and 30 days, "week" bars (starting Monday) for 90 days and all time. */
  granularity: z.enum(["day", "week"]),
  byPeriod: z.array(studyPeriodSchema),
  bySubject: z.array(z.object({ subject: z.string(), minutes, sessions: z.number().int() })),
  byActivity: z.array(z.object({ activityType: activityTypeSchema, minutes, sessions: z.number().int(), percentage: percent })),
});
export type StudyTime = z.infer<typeof studyTimeSchema>;

export const streakSchema = z.object({
  /** null when there is no completed session at all (shown as "Not enough data yet"). */
  current: z.number().int().min(0).nullable(),
  longest: z.number().int().min(0).nullable(),
  studyDays: z.number().int().min(0),
  lastStudyDate: localDate.nullable(),
});
export type Streak = z.infer<typeof streakSchema>;

export const scorePointSchema = z.object({ attemptId: z.string(), date: localDate, percentage: percent, quizTitle: z.string() });
export const quizStatsSchema = z.object({
  attemptsCompleted: z.number().int().min(0),
  quizzesCompleted: z.number().int().min(0),
  /** Quizzes the student started in the period (finished or not). */
  quizzesAttempted: z.number().int().min(0),
  averageScore: percent.nullable(),
  highestScore: percent.nullable(),
  lowestScore: percent.nullable(),
  recentScore: percent.nullable(),
  previousAverageScore: percent.nullable(),
  questions: z.number().int().min(0),
  correct: z.number().int().min(0),
  incorrect: z.number().int().min(0),
  unanswered: z.number().int().min(0),
  accuracy: percent.nullable(),
  /** Oldest first, at most the latest 30 finished attempts. */
  trend: z.array(scorePointSchema),
  byDifficulty: z.array(z.object({ difficulty: z.enum(["easy", "medium", "hard"]), questions: z.number().int(), correct: z.number().int(), accuracy: percent.nullable() })),
});
export type QuizStats = z.infer<typeof quizStatsSchema>;

export const topicTrendSchema = z.object({ previous: percent, recent: percent, delta: z.number() });
export const topicStatSchema = z.object({
  topic: z.string(),
  subject: z.string().nullable(),
  correct: z.number().int().min(0),
  total: z.number().int().min(0),
  /** null while there is not enough data (level "insufficient"). */
  accuracy: percent.nullable(),
  level: masteryLevelSchema,
  /** Present only when both the earlier and the recent part have enough questions. */
  trend: topicTrendSchema.nullable(),
});
export type TopicStat = z.infer<typeof topicStatSchema>;

export const subjectStatSchema = z.object({
  subject: z.string(),
  studyMinutes: minutes,
  completedSessions: z.number().int().min(0),
  quizzes: z.number().int().min(0),
  questions: z.number().int().min(0),
  accuracy: percent.nullable(),
  level: masteryLevelSchema,
  topics: z.array(topicStatSchema),
});
export type SubjectStat = z.infer<typeof subjectStatSchema>;

export const progressActivitySchema = z.object({
  id: z.string(),
  type: z.enum(["session_completed", "session_skipped", "quiz_completed"]),
  at: isoTime,
  title: z.string(),
  detail: z.string().nullable(),
  /** The student's local calendar day of the event, for "Today" / "Yesterday" grouping. */
  date: localDate,
  href: z.string().nullable(),
});
export type ProgressActivity = z.infer<typeof progressActivitySchema>;

/* ---- Viva numbers on the Progress page (kept separate from the quiz numbers) ---- */
/** A completed viva's numbers for the Progress page (kept separate from quiz numbers). */
export const vivaProgressSchema = z.object({
  sessionsCompleted: z.number().int().min(0),
  averageScore: z.number().min(0).max(100).nullable(),
  bestScore: z.number().min(0).max(100).nullable(),
  recentScore: z.number().min(0).max(100).nullable(),
  dimensions: z.object({ correctness: z.number(), completeness: z.number(), clarity: z.number(), confidence: z.number() }).nullable(),
  bySubject: z.array(z.object({ subject: z.string(), sessions: z.number().int(), averageScore: z.number() })),
  recent: z.array(z.object({ id: z.string().uuid(), subject: z.string(), topic: z.string().nullable(), score: z.number(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
});
export type VivaProgress = z.infer<typeof vivaProgressSchema>;

/** For the dashboard card: the latest completed viva (any time), or null when there is none. */
export const vivaSnapshotSchema = z.object({
  lastScore: z.number().min(0).max(100),
  subject: z.string(),
  topic: z.string().nullable(),
  completedCount: z.number().int().min(1),
});
export type VivaSnapshot = z.infer<typeof vivaSnapshotSchema>;

export const progressResponseSchema = z.object({
  range: progressRangeSchema,
  timezone: z.string(),
  today: localDate,
  /** First and last local day of the period (from is null for "All time"). */
  from: localDate.nullable(),
  to: localDate,
  studyTime: studyTimeSchema,
  streak: streakSchema,
  quiz: quizStatsSchema,
  subjects: z.array(subjectStatSchema),
  topics: z.array(topicStatSchema),
  topicSummary: z.object({
    /** Distinct topics from completed sessions and answered quiz questions. */
    studied: z.number().int().min(0),
    withEnoughData: z.number().int().min(0),
    strong: z.number().int().min(0),
    needsPractice: z.number().int().min(0),
    weak: z.number().int().min(0),
  }),
  /** Weakest first, labelled "weak" only. */
  weakAreas: z.array(topicStatSchema),
  improving: z.array(topicStatSchema),
  /** false when no topic has enough history to compare - the page then asks for more quizzes. */
  improvementComparable: z.boolean(),
  activity: z.array(progressActivitySchema),
  /** AI Viva results. Never mixed into the quiz numbers above. */
  viva: vivaProgressSchema,
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/** The compact numbers for the dashboard. Always last 30 days (streak: all time). */
export const progressSnapshotSchema = z.object({
  studyMinutes: minutes,
  studiedToday: minutes,
  averageScore: percent.nullable(),
  attemptsCompleted: z.number().int().min(0),
  currentStreak: z.number().int().min(0).nullable(),
  weakTopic: z.object({ topic: z.string(), subject: z.string().nullable(), accuracy: percent, total: z.number().int() }).nullable(),
  weakTopics: z.array(z.object({ topic: z.string(), subject: z.string().nullable(), accuracy: percent, total: z.number().int() })),
  /** The latest completed viva (any time), or null when there is none. */
  viva: vivaSnapshotSchema.nullable(),
  /** Phase 12: the student's main subjects (most study time / questions first), from the same numbers as the Progress page. */
  subjectOverview: z.array(z.object({ subject: z.string(), accuracy: percent.nullable(), level: masteryLevelSchema, questions: z.number().int().min(0), studyMinutes: minutes })).optional(),
});
export type ProgressSnapshot = z.infer<typeof progressSnapshotSchema>;
