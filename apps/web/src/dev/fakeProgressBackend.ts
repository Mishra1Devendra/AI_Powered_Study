import type { ProgressRange, ProgressResponse, TopicStat } from "@copilot/shared";

/**
 * Fake in-memory progress for tests and the DEV-only /dev/progress preview. The numbers are fixtures (marked as
 * such on the preview page) and are never produced for a real student. Never bundled into production: its only
 * non-test importer is the lazy, DEV-gated preview page.
 */

export interface Call {
  method: string;
  url: string;
}

const topic = (over: Partial<TopicStat> & Pick<TopicStat, "topic" | "correct" | "total" | "level">): TopicStat => ({
  subject: "Physics",
  accuracy: over.level === "insufficient" ? null : Math.round((over.correct / over.total) * 1000) / 10,
  trend: null,
  ...over,
});

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

/** A student with a bit of everything. */
export function richProgress(range: ProgressRange = "30d", today = "2026-10-15"): ProgressResponse {
  const bars = days("2026-09-16", 30).map((start, i) => ({ start, minutes: [0, 45, 30, 0, 60, 90, 0][i % 7]!, sessions: [0, 1, 1, 0, 2, 3, 0][i % 7]! }));
  const total = bars.reduce((m, b) => m + b.minutes, 0);
  const weak = topic({ topic: "Electrostatics", subject: "Physics", correct: 3, total: 8, level: "weak" });
  const improving = topic({ topic: "Thermodynamics", correct: 8, total: 10, level: "strong", trend: { previous: 58, recent: 76, delta: 18 } });
  const mid = topic({ topic: "Integration", subject: "Mathematics", correct: 8, total: 13, level: "needs_practice" });
  const thin = topic({ topic: "Organic chemistry", subject: "Chemistry", correct: 2, total: 3, level: "insufficient" });
  return {
    range,
    timezone: "Asia/Kolkata",
    today,
    from: range === "all" ? null : "2026-09-16",
    to: today,
    studyTime: {
      totalMinutes: total,
      previousMinutes: range === "all" ? null : 700,
      completedSessions: 24,
      skippedSessions: 3,
      missedSessions: 2,
      upcomingSessions: 12,
      completionRate: 82.8,
      activeDays: 17,
      averageMinutesPerActiveDay: Math.round(total / 17),
      granularity: range === "7d" || range === "30d" ? "day" : "week",
      byPeriod: range === "7d" ? bars.slice(-7) : bars,
      bySubject: [
        { subject: "Physics", minutes: 540, sessions: 11 },
        { subject: "Mathematics", minutes: 420, sessions: 9 },
        { subject: "Chemistry", minutes: 150, sessions: 4 },
      ],
      byActivity: [
        { activityType: "learn", minutes: 450, sessions: 10, percentage: 40.5 },
        { activityType: "practice", minutes: 330, sessions: 7, percentage: 29.7 },
        { activityType: "revision", minutes: 210, sessions: 5, percentage: 18.9 },
        { activityType: "quiz", minutes: 120, sessions: 2, percentage: 10.8 },
      ],
    },
    streak: { current: 5, longest: 9, studyDays: 21, lastStudyDate: today },
    quiz: {
      attemptsCompleted: 6,
      quizzesCompleted: 4,
      quizzesAttempted: 5,
      averageScore: 73.3,
      highestScore: 90,
      lowestScore: 50,
      recentScore: 82,
      previousAverageScore: 64,
      questions: 60,
      correct: 44,
      incorrect: 14,
      unanswered: 2,
      accuracy: 73.3,
      trend: [
        { attemptId: "a1", date: "2026-09-20", percentage: 50, quizTitle: "Heat basics" },
        { attemptId: "a2", date: "2026-09-27", percentage: 62, quizTitle: "Waves" },
        { attemptId: "a3", date: "2026-10-02", percentage: 70, quizTitle: "Mechanics" },
        { attemptId: "a4", date: "2026-10-06", percentage: 78, quizTitle: "Heat basics" },
        { attemptId: "a5", date: "2026-10-10", percentage: 90, quizTitle: "Integration" },
        { attemptId: "a6", date: "2026-10-14", percentage: 82, quizTitle: "Thermodynamics" },
      ],
      byDifficulty: [
        { difficulty: "easy", questions: 20, correct: 18, accuracy: 90 },
        { difficulty: "medium", questions: 28, correct: 20, accuracy: 71.4 },
        { difficulty: "hard", questions: 12, correct: 6, accuracy: 50 },
      ],
    },
    subjects: [
      { subject: "Physics", studyMinutes: 540, completedSessions: 11, quizzes: 3, questions: 34, accuracy: 70.6, level: "needs_practice", topics: [weak, improving] },
      { subject: "Mathematics", studyMinutes: 420, completedSessions: 9, quizzes: 1, questions: 13, accuracy: 61.5, level: "needs_practice", topics: [mid] },
      { subject: "Chemistry", studyMinutes: 150, completedSessions: 4, quizzes: 1, questions: 3, accuracy: null, level: "insufficient", topics: [thin] },
    ],
    topics: [weak, mid, improving, thin],
    topicSummary: { studied: 9, withEnoughData: 3, strong: 1, needsPractice: 1, weak: 1 },
    weakAreas: [weak],
    improving: [improving],
    improvementComparable: true,
    activity: [
      { id: "e1", type: "session_completed", at: `${today}T08:30:00.000Z`, date: today, title: "Completed Physics — Thermodynamics", detail: "45 min", href: "/study-plan?session=s1" },
      { id: "e2", type: "quiz_completed", at: "2026-10-14T16:00:00.000Z", date: "2026-10-14", title: "Completed quiz — Thermodynamics", detail: "82%", href: "/quiz/attempt/a6/result" },
      { id: "e3", type: "session_completed", at: "2026-10-14T09:00:00.000Z", date: "2026-10-14", title: "Completed Mathematics — Integration", detail: "30 min", href: "/study-plan?session=s2" },
      { id: "e4", type: "session_skipped", at: "2026-10-13T09:00:00.000Z", date: "2026-10-13", title: "Skipped Chemistry — Bonding", detail: "30 min", href: "/study-plan?session=s3" },
    ],
    viva: {
      sessionsCompleted: 3,
      averageScore: 71.7,
      bestScore: 86,
      recentScore: 74,
      dimensions: { correctness: 76.7, completeness: 66.7, clarity: 80, confidence: 70 },
      bySubject: [
        { subject: "Physics", sessions: 2, averageScore: 80 },
        { subject: "Chemistry", sessions: 1, averageScore: 55 },
      ],
      recent: [
        { id: "00000000-0000-4000-8000-0000000000b3", subject: "Physics", topic: "Thermodynamics", score: 74, date: "2026-10-14" },
        { id: "00000000-0000-4000-8000-0000000000b2", subject: "Chemistry", topic: "Reaction rates", score: 55, date: "2026-10-09" },
        { id: "00000000-0000-4000-8000-0000000000b1", subject: "Physics", topic: null, score: 86, date: "2026-10-03" },
      ],
    },
  };
}

/** A student who has just signed up. */
export function emptyProgress(range: ProgressRange = "30d", today = "2026-10-15"): ProgressResponse {
  return {
    range,
    timezone: "Asia/Kolkata",
    today,
    from: range === "all" ? null : "2026-09-16",
    to: today,
    studyTime: { totalMinutes: 0, previousMinutes: null, completedSessions: 0, skippedSessions: 0, missedSessions: 0, upcomingSessions: 0, completionRate: null, activeDays: 0, averageMinutesPerActiveDay: null, granularity: "day", byPeriod: [], bySubject: [], byActivity: [] },
    streak: { current: null, longest: null, studyDays: 0, lastStudyDate: null },
    quiz: { attemptsCompleted: 0, quizzesCompleted: 0, quizzesAttempted: 0, averageScore: null, highestScore: null, lowestScore: null, recentScore: null, previousAverageScore: null, questions: 0, correct: 0, incorrect: 0, unanswered: 0, accuracy: null, trend: [], byDifficulty: [] },
    subjects: [],
    topics: [],
    topicSummary: { studied: 0, withEnoughData: 0, strong: 0, needsPractice: 0, weak: 0 },
    weakAreas: [],
    improving: [],
    improvementComparable: false,
    activity: [],
    viva: { sessionsCompleted: 0, averageScore: null, bestScore: null, recentScore: null, dimensions: null, bySubject: [], recent: [] },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function makeProgressBackend(respond: (range: ProgressRange) => ProgressResponse = (r) => richProgress(r)) {
  const calls: Call[] = [];
  const knobs = { failNext: false, delayMs: 0 };
  async function fetchMock(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    // The app asks who the account is (role / paused) once on load; that is not one of this feature's requests.
    if (url === "/api/me") return json(200, { user: { id: "11111111-1111-4111-8111-111111111111", email: "sample@example.com" }, profile: { id: "11111111-1111-4111-8111-111111111111", displayName: "Sample", timezone: "UTC", role: "student" } });
    calls.push({ method: (init.method ?? "GET").toUpperCase(), url });
    if (knobs.delayMs) await new Promise((r) => setTimeout(r, knobs.delayMs));
    if (knobs.failNext) {
      knobs.failNext = false;
      return json(500, { error: "internal_error", message: "Something went wrong." });
    }
    const m = /^\/api\/progress\/summary\?range=(7d|30d|90d|all)$/.exec(url);
    if (m) return json(200, respond(m[1] as ProgressRange));
    return json(404, { error: "not_found", message: "Not found." });
  }
  return { fetchMock, calls, knobs };
}
