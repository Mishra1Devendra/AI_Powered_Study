import type { ActivityType, KnowledgeLevel, PlanStatus, PreferredTime, Priority, SessionStatus, StudySession } from "@copilot/shared";

export const ACTIVITY_INFO: Record<ActivityType, { label: string; classes: string }> = {
  learn: { label: "Learn", classes: "bg-sky-50 text-sky-800 ring-sky-200" },
  practice: { label: "Practice", classes: "bg-violet-50 text-violet-800 ring-violet-200" },
  quiz: { label: "Quiz", classes: "bg-amber-50 text-amber-900 ring-amber-200" },
  revision: { label: "Revision", classes: "bg-teal-50 text-teal-800 ring-teal-200" },
  mock_test: { label: "Practice test", classes: "bg-rose-50 text-rose-800 ring-rose-200" },
};

/** Status is always shown as text (with an icon), never by colour alone. */
export const SESSION_STATUS_INFO: Record<SessionStatus, { label: string; classes: string }> = {
  planned: { label: "Planned", classes: "bg-white text-slate-700 ring-slate-200" },
  in_progress: { label: "In progress", classes: "bg-brand-50 text-brand-800 ring-brand-200" },
  completed: { label: "Completed", classes: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  skipped: { label: "Skipped", classes: "bg-slate-100 text-slate-700 ring-slate-200" },
  missed: { label: "Missed", classes: "bg-red-50 text-red-800 ring-red-200" },
  rescheduled: { label: "Rescheduled", classes: "bg-slate-50 text-slate-600 ring-slate-200" },
};

export const PLAN_STATUS_INFO: Record<PlanStatus, { label: string; classes: string }> = {
  generating: { label: "Being created", classes: "bg-brand-50 text-brand-800 ring-brand-200" },
  active: { label: "Active", classes: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  archived: { label: "Previous plan", classes: "bg-slate-100 text-slate-700 ring-slate-200" },
  failed: { label: "Not created", classes: "bg-red-50 text-red-800 ring-red-200" },
};

export const LEVEL_LABEL: Record<KnowledgeLevel, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };
export const PRIORITY_LABEL: Record<Priority, string> = { high: "High", medium: "Medium", low: "Low" };
export const TIME_LABEL: Record<PreferredTime, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening", any: "Any time" };

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A session still counts towards its day unless it was moved away. */
export const isVisible = (s: StudySession) => s.status !== "rescheduled";

/** The prompt handed to the AI Tutor for a session. Nothing is sent until the student presses send. */
export function tutorDraft(s: Pick<StudySession, "subject" | "topic" | "activityType">): string {
  switch (s.activityType) {
    case "learn":
      return `Teach me ${s.topic} (${s.subject}) step by step, starting from the basics.`;
    case "practice":
      return `Give me practice problems on ${s.topic} (${s.subject}), one at a time, and check my answers.`;
    case "quiz":
    case "mock_test":
      return `Ask me exam-style questions on ${s.topic} (${s.subject}) and tell me what I got wrong.`;
    case "revision":
      return `Help me revise ${s.topic} (${s.subject}): summarise the key points and test me on them.`;
  }
}
