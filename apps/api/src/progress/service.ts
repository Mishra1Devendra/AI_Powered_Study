import type { ProgressRange, ProgressResponse, ProgressSnapshot } from "@copilot/shared";
import { boundsFor, quizStats, rangeDays, recentActivity, streakStats, studyTimeStats, topicAnalysis, vivaStats, type AttemptFact, type Bounds } from "./compute.js";
import type { ProgressData, ProgressRepository } from "./repository.js";

const RECENT_LIMIT = 12;
const SNAPSHOT_WEAK_TOPICS = 3;

export interface ProgressServiceDeps {
  repo: ProgressRepository;
  now?: () => Date;
}

/** The finished attempts whose local day falls in a period. */
const inPeriod = (attempts: readonly AttemptFact[], from: string | null, to: string) => attempts.filter((a) => (from === null || a.date >= from) && a.date <= to);

/**
 * Progress & analytics for ONE student. The student id always comes from the verified token; every query
 * is scoped to it (and to Row Level Security in the database). No AI is involved anywhere in this file:
 * every number is calculated from the student's own sessions and quiz attempts.
 */
export function createProgressService({ repo, now = () => new Date() }: ProgressServiceDeps) {
  async function read(userId: string, range: ProgressRange, recent: boolean) {
    // The database decides "today" in the student's timezone and hands it back, so the period below is exactly theirs.
    const { timezone, today, data } = await repo.load(userId, { now: now(), rangeDays: rangeDays(range), recent });
    return { timezone, data, today, bounds: boundsFor(range, today) };
  }

  function currentAndPrevious(data: ProgressData, bounds: Bounds) {
    return {
      current: inPeriod(data.attempts, bounds.from, bounds.to),
      previous: bounds.prevFrom !== null && bounds.prevTo !== null ? inPeriod(data.attempts, bounds.prevFrom, bounds.prevTo) : [],
    };
  }

  return {
    async summary(userId: string, range: ProgressRange): Promise<ProgressResponse> {
      const { timezone, data, today, bounds } = await read(userId, range, true);
      const { current, previous } = currentAndPrevious(data, bounds);
      const analysis = topicAnalysis(data.sessions, bounds, today, current, data.breakdown);
      return {
        range,
        timezone,
        today,
        from: bounds.from,
        to: bounds.to,
        studyTime: studyTimeStats(data.sessions, bounds, today, range),
        streak: streakStats(data.studyDates, today),
        quiz: quizStats(current, previous, data.breakdown, data.quizzesAttempted),
        subjects: analysis.subjects,
        topics: analysis.topics,
        topicSummary: analysis.summary,
        weakAreas: analysis.weakAreas,
        improving: analysis.improving,
        improvementComparable: analysis.improvementComparable,
        activity: recentActivity(data.recentSessions, data.recentAttempts, RECENT_LIMIT),
        viva: vivaStats(data.viva),
      };
    },

    /** The compact numbers for the dashboard: the last 30 days (the streak is all time). */
    async snapshot(userId: string): Promise<ProgressSnapshot> {
      const { data, today, bounds } = await read(userId, "30d", false);
      const { current } = currentAndPrevious(data, bounds);
      const study = studyTimeStats(data.sessions, bounds, today, "30d");
      const analysis = topicAnalysis(data.sessions, bounds, today, current, data.breakdown);
      const quiz = quizStats(current, [], data.breakdown, 0);
      const weak = analysis.weakAreas.map((t) => ({ topic: t.topic, subject: t.subject, accuracy: t.accuracy ?? 0, total: t.total }));
      return {
        studyMinutes: study.totalMinutes,
        studiedToday: data.sessions.filter((s) => s.status === "completed" && s.completedDate === today).reduce((m, s) => m + s.durationMinutes, 0),
        averageScore: quiz.averageScore,
        attemptsCompleted: quiz.attemptsCompleted,
        currentStreak: streakStats(data.studyDates, today).current,
        weakTopic: weak[0] ?? null,
        weakTopics: weak.slice(0, SNAPSHOT_WEAK_TOPICS),
        viva: data.lastViva ? { lastScore: data.lastViva.score, subject: data.lastViva.subject, topic: data.lastViva.topic, completedCount: data.lastViva.total } : null,
        // The same subject numbers as the Progress page (accuracy only once there are enough questions).
        subjectOverview: analysis.subjects.slice(0, 4).map((s) => ({ subject: s.subject, accuracy: s.accuracy, level: s.level, questions: s.questions, studyMinutes: s.studyMinutes })),
      };
    },
  };
}

export type ProgressService = ReturnType<typeof createProgressService>;
