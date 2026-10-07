import { Link } from "react-router";
import type { Dashboard } from "@copilot/shared";
import { FlameIcon } from "../../components/ui/Icons";
import { firstName, formatMinutes, formatToday, greetingFor, initials } from "./format";

/** A one-line, honest summary of today from real data; a gentle default when there is nothing to say. */
export function contextMessage(d: Pick<Dashboard, "plan" | "today">): string {
  const open = d.plan.filter((p) => p.status !== "done");
  if (open.length > 0) {
    const minutes = open.reduce((m, p) => m + p.durationMinutes, 0);
    return `You have ${open.length} study ${open.length === 1 ? "session" : "sessions"} left today (${formatMinutes(minutes)}).`;
  }
  if (d.plan.length > 0) return "You've finished today's study plan. Nice work.";
  return "Let's make today's study session count.";
}

/** Welcome, today's date, one honest line about today, a streak badge when it is real, and the profile link. */
export function DashboardHeader({ displayName, now, summary, streakDays }: { displayName: string; now: Date; summary?: string; streakDays?: number | null }) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          <time dateTime={now.toISOString()}>{formatToday(now)}</time>
        </p>
        <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-[2.6rem] sm:leading-[1.1]">
          {greetingFor(now)}, {firstName(displayName)} <span aria-hidden="true">👋</span>
        </h1>
        <p className="mt-1.5 text-base text-slate-600">{summary ?? "Let's make today's study session count."}</p>
        {streakDays != null && streakDays > 0 && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent-50 px-3 py-1 text-sm font-medium text-accent-800 ring-1 ring-accent-200">
            <FlameIcon className="h-4 w-4 text-accent-600" />
            {streakDays}-day study streak
          </p>
        )}
      </div>
      <Link
        to="/settings"
        aria-label="Profile and settings"
        title="Profile and settings"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
      >
        {initials(displayName)}
      </Link>
    </header>
  );
}
