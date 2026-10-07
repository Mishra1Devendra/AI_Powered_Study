import type { ActivityItem, AttemptHistoryItem, Conversation, Dashboard, Note, ProgressSnapshot, SessionStatus } from "@copilot/shared";

import { pickResume, type UnfinishedViva } from "./resume.js";

export interface DashboardSources {
  /** Phase 12: the student's vivas that are still in progress (for "continue learning"). */
  unfinishedVivas?: UnfinishedViva[];
  /** Overridable for tests. */
  now?: Date;
  /** Most recent AI tutor conversations (already limited to the student's own). */
  recentConversations: Conversation[];
  /** Most recently used notes. */
  recentNotes?: Note[];
  /** The student's most recent quiz attempts (any status), newest first. */
  recentQuizAttempts?: AttemptHistoryItem[];
  /** Today's sessions of the active study plan, or null when the student has no active plan. */
  /** The student's real progress numbers (null/absent when unavailable). */
  progress?: ProgressSnapshot | null;
  studyPlanToday?: {
    sessions: Array<{ id: string; subject: string; topic: string; startTime: string | null; durationMinutes: number; status: SessionStatus }>;
  } | null;
}

const PLAN_ITEM_STATUS: Partial<Record<SessionStatus, Dashboard["plan"][number]["status"]>> = { planned: "todo", in_progress: "in_progress", completed: "done" };

/** Today's real study sessions as dashboard plan items (only sessions that still belong to today). */
function planItems(today: NonNullable<DashboardSources["studyPlanToday"]>): Dashboard["plan"] {
  return today.sessions.flatMap((s) => {
    const status = PLAN_ITEM_STATUS[s.status];
    return status ? [{ id: s.id, subject: s.subject, topic: s.topic, startTime: s.startTime, durationMinutes: s.durationMinutes, status, href: `/study-plan?session=${s.id}` }] : [];
  });
}

/** Attempts that have a score (submitted, or closed when the timer ran out). */
const finished = (a: AttemptHistoryItem) => a.status !== "in_progress" && a.percentage !== null && a.submittedAt !== null;

/** One recent-activity row per finished quiz attempt. */
function quizActivity(a: AttemptHistoryItem): ActivityItem {
  return {
    id: `quiz-${a.id}`,
    type: "quiz",
    title: a.quizTitle,
    detail: `${a.score}/${a.total} · ${Math.round(a.percentage ?? 0)}%`,
    occurredAt: a.submittedAt!,
    href: `/quiz/attempt/${a.id}/result`,
  };
}

/** Average of the latest finished attempts, or null when there are none (never a made-up number). */
function quizAverage(attempts: AttemptHistoryItem[]): number | null {
  const scores = attempts.filter(finished).slice(0, 10).map((a) => a.percentage!);
  return scores.length ? Math.round(scores.reduce((s, p) => s + p, 0) / scores.length) : null;
}

/** One recent-activity row per tutor conversation. */
function tutorActivity(c: Conversation): ActivityItem {
  const detail = [c.subject, c.topic].filter(Boolean).join(" · ");
  return {
    id: `tutor-${c.id}`,
    type: "tutor",
    title: c.title,
    detail: detail || null,
    occurredAt: c.updatedAt,
    href: `/tutor/${c.id}`,
  };
}

/** One recent-activity row per note (ready ones link to the workspace; others to the library). */
function noteActivity(n: Note): ActivityItem {
  const detail = n.status === "ready" ? `${n.chunkCount} sections${n.pageCount ? ` · ${n.pageCount} pages` : ""}` : n.status === "failed" ? "Needs attention" : "Processing";
  return { id: `note-${n.id}`, type: "note", title: n.title, detail, occurredAt: n.lastActivityAt, href: `/notes/${n.id}` };
}

/**
 * Assembles the dashboard payload for one student.
 *
 * Real data today: the profile, recent AI tutor conversations and recent notes (-> recent activity).
 * Every other section is returned EMPTY (null / []) - never invented - and the UI shows an
 * empty state. Each later phase fills in its section from its own table (all read through
 * `withUser`, so RLS applies):
 *
 *   today.studyMinutes, activity (session)     <- study_sessions        (later)
 *   (done in Phase 7) plan, today.plannedMinutes/tasks* <- study_sessions of the active study plan
 *   (done in Phase 5) today.quizAveragePercent, activity (quiz) <- quiz_attempts
 *   weakTopics                                 <- weak_topics           (Phase 6)
 *   subjects, continueLearning                 <- subjects/topic_progress (Phases 5-8)
 *   subjects/topic progress from notes          <- later phases
 *   today.streakDays                           <- derived from study_sessions
 */
export function buildDashboard(
  profile: Dashboard["profile"],
  sources: DashboardSources = { recentConversations: [] },
): Dashboard {
  const plan = sources.studyPlanToday ? planItems(sources.studyPlanToday) : [];
  const hasPlan = Boolean(sources.studyPlanToday);
  const progress = sources.progress ?? null;
  // A student with at least one study day has a real streak and a real "studied today" (possibly 0).
  const hasStudied = progress !== null && progress.currentStreak !== null;
  const activity = [
    ...sources.recentConversations.map(tutorActivity),
    ...(sources.recentNotes ?? []).map(noteActivity),
    ...(sources.recentQuizAttempts ?? []).filter(finished).map(quizActivity),
  ]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 5);
  return {
    profile,
    today: {
      studyMinutes: hasStudied ? progress.studiedToday : null,
      // With an active plan these are real numbers (0 on a rest day); without one they stay "not tracked".
      plannedMinutes: hasPlan ? plan.reduce((m, p) => m + p.durationMinutes, 0) : null,
      tasksCompleted: hasPlan ? plan.filter((p) => p.status === "done").length : null,
      tasksPlanned: hasPlan ? plan.length : null,
      quizAveragePercent: quizAverage(sources.recentQuizAttempts ?? []),
      streakDays: hasStudied ? progress.currentStreak : null,
    },
    continueLearning: null,
    resume: pickResume({ plan, quizAttempts: sources.recentQuizAttempts ?? [], vivas: sources.unfinishedVivas ?? [], activity, now: sources.now ?? new Date() }),
    plan,
    // Topics that are "weak" by the documented thresholds in the student's own finished quizzes.
    weakTopics: (progress?.weakTopics ?? []).map((t, i) => ({ id: `weak-${i}`, subject: t.subject ?? "Quiz topic", topic: t.topic, status: "needs_attention" as const, accuracyPercent: t.accuracy, href: "/progress" })),
    subjects: [],
    activity,
    progress,
  };
}
