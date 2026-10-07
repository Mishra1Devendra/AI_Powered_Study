import type { Dashboard } from "@copilot/shared";

/**
 * SAMPLE DATA - for design preview and tests only. Never shown for a real student and never
 * written to the database. The only consumer outside tests is the DEV-only /dev/dashboard route,
 * which is stripped from production builds.
 */
export function sampleDashboard(now: Date): Dashboard {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return {
    profile: { displayName: "Sample Student", timezone: "UTC" },
    today: { studyMinutes: 65, plannedMinutes: 150, tasksCompleted: 1, tasksPlanned: 3, quizAveragePercent: 74, streakDays: 5 },
    continueLearning: {
      subject: "Mathematics",
      topic: "Integration by substitution",
      progressPercent: 62,
      lastStudiedAt: ago(95),
      href: "/tutor",
    },
    plan: [
      { id: "p1", subject: "Mathematics", topic: "Integration by substitution", startTime: "09:00", durationMinutes: 60, status: "done", href: "/study-plan" },
      { id: "p2", subject: "Physics", topic: "Electromagnetic induction", startTime: "10:15", durationMinutes: 45, status: "in_progress", href: "/study-plan" },
      { id: "p3", subject: "Chemistry", topic: "Organic reaction mechanisms", startTime: "11:30", durationMinutes: 45, status: "todo", href: "/study-plan" },
    ],
    weakTopics: [
      { id: "w1", subject: "Mathematics", topic: "Integration by substitution", status: "needs_attention", accuracyPercent: 48, href: "/quiz" },
      { id: "w2", subject: "Physics", topic: "Electromagnetism", status: "improving", accuracyPercent: 66, href: "/quiz" },
    ],
    subjects: [
      { id: "s1", name: "Mathematics", progressPercent: 62, topicsCompleted: 8, topicsTotal: 13 },
      { id: "s2", name: "Physics", progressPercent: 41, topicsCompleted: 5, topicsTotal: 12 },
      { id: "s3", name: "Chemistry", progressPercent: 18, topicsCompleted: 2, topicsTotal: 11 },
    ],
    activity: [
      { id: "a1", type: "session", title: "Integration by substitution", detail: "60 min", occurredAt: ago(95), href: null },
      { id: "a2", type: "quiz", title: "Calculus checkpoint", detail: "7 of 10 correct", occurredAt: ago(60 * 26), href: null },
      { id: "a3", type: "note", title: "Chapter 4 - Electromagnetism.pdf", detail: "Summary generated", occurredAt: ago(60 * 50), href: null },
      { id: "a4", type: "tutor", title: "Why does u-substitution work?", detail: null, occurredAt: ago(60 * 24 * 4), href: null },
    ],
    progress: { studyMinutes: 380, studiedToday: 65, averageScore: 78, attemptsCompleted: 6, currentStreak: 5, weakTopic: { topic: "Integration", subject: "Mathematics", accuracy: 48, total: 12 }, weakTopics: [{ topic: "Integration", subject: "Mathematics", accuracy: 48, total: 12 }], viva: { lastScore: 78, subject: "Physics", topic: "Thermodynamics", completedCount: 3 } },
  };
}

/** The truthful empty dashboard a brand-new student sees (matches what the API returns today). */
export function emptyDashboard(displayName = "Sample Student"): Dashboard {
  return {
    profile: { displayName, timezone: "UTC" },
    today: { studyMinutes: null, plannedMinutes: null, tasksCompleted: null, tasksPlanned: null, quizAveragePercent: null, streakDays: null },
    continueLearning: null,
    plan: [],
    weakTopics: [],
    subjects: [],
    activity: [],
    progress: null,
  };
}
