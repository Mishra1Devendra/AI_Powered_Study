import type { ActivityItem, AttemptHistoryItem, Dashboard, ResumeItem } from "@copilot/shared";

/** How long an unfinished activity is still worth resuming (an attempt left open last month is not "continue learning"). */
const FRESH_MS = { quiz: 3 * 24 * 3600_000, viva: 7 * 24 * 3600_000, activity: 14 * 24 * 3600_000 } as const;

export interface UnfinishedViva {
  id: string;
  subject: string;
  topic: string | null;
  questionCount: number;
  answeredCount: number;
  /** ISO time the viva was started. */
  startedAt: string;
}

const within = (iso: string, ms: number, now: Date) => now.getTime() - Date.parse(iso) <= ms;

/**
 * The ONE most useful thing to pick up, from the student's real records only:
 *   1. a study session that is in progress, 2. an unfinished quiz attempt, 3. an unfinished viva,
 *   4. the next study session planned for today, 5. the most recent tutor chat / note / quiz result.
 * Nothing is invented: with none of these the answer is null and the app falls back to its top recommendation or an empty state.
 */
export function pickResume(args: { plan: Dashboard["plan"]; quizAttempts: readonly AttemptHistoryItem[]; vivas: readonly UnfinishedViva[]; activity: readonly ActivityItem[]; now: Date }): ResumeItem | null {
  const { plan, quizAttempts, vivas, activity, now } = args;

  const active = plan.find((p) => p.status === "in_progress");
  if (active) {
    return { kind: "session", eyebrow: "Study session in progress", title: `Continue ${active.topic}`, detail: `${active.subject} · ${active.durationMinutes} min planned`, cta: "Continue session", href: active.href, at: null };
  }

  const quiz = quizAttempts.find((a) => a.status === "in_progress" && within(a.startedAt, FRESH_MS.quiz, now));
  if (quiz) {
    return { kind: "quiz", eyebrow: "Unfinished quiz", title: `Finish ${quiz.quizTitle}`, detail: `${quiz.questionCount} questions · ${quiz.sourceLabel}`, cta: "Continue quiz", href: `/quiz/attempt/${quiz.id}`, at: quiz.startedAt };
  }

  const viva = vivas.find((v) => within(v.startedAt, FRESH_MS.viva, now));
  if (viva) {
    const what = viva.topic ?? viva.subject;
    return { kind: "viva", eyebrow: "Viva in progress", title: `Continue your viva on ${what}`, detail: `Question ${Math.min(viva.answeredCount + 1, viva.questionCount)} of ${viva.questionCount}`, cta: "Continue viva", href: `/viva/${viva.id}`, at: viva.startedAt };
  }

  const next = plan.find((p) => p.status === "todo");
  if (next) {
    return { kind: "session", eyebrow: "Up next today", title: `Start ${next.topic}`, detail: `${next.subject} · ${next.durationMinutes} min planned`, cta: "Start session", href: next.href, at: null };
  }

  const recent = activity.find((a) => a.href !== null && within(a.occurredAt, FRESH_MS.activity, now));
  if (recent) {
    const kind = recent.type === "tutor" ? "tutor" : recent.type === "note" ? "note" : recent.type === "quiz" ? "quiz" : "session";
    const eyebrow = recent.type === "tutor" ? "Pick up your conversation" : recent.type === "note" ? "Back to your notes" : recent.type === "quiz" ? "Review your last quiz" : "Pick up where you left off";
    return { kind, eyebrow, title: recent.title, detail: recent.detail, cta: recent.type === "quiz" ? "See results" : "Continue", href: recent.href!, at: recent.occurredAt };
  }
  return null;
}
