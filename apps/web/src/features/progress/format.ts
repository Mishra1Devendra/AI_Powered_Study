import type { ActivityType, MasteryLevel, ProgressActivity } from "@copilot/shared";

export { formatMinutes } from "../dashboard/format";

export const pctText = (n: number | null) => (n === null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)}%`);

/** Level styling: always paired with a text label and an icon, never colour alone. */
export const LEVEL_STYLE: Record<MasteryLevel, { badge: string; bar: string; icon: string }> = {
  strong: { badge: "bg-emerald-50 text-emerald-800 ring-emerald-200", bar: "#059669", icon: "M3 8.5l3.2 3L13 4.5" },
  needs_practice: { badge: "bg-amber-50 text-amber-900 ring-amber-200", bar: "#d97706", icon: "M3 8h10" },
  weak: { badge: "bg-red-50 text-red-800 ring-red-200", bar: "#dc2626", icon: "M8 3.5v6M8 12v.5" },
  insufficient: { badge: "bg-slate-100 text-slate-700 ring-slate-200", bar: "#94a3b8", icon: "M5 8h.01M8 8h.01M11 8h.01" },
};

export const ACTIVITY_COLOR: Record<ActivityType, string> = {
  learn: "#0284c7",
  practice: "#7c3aed",
  quiz: "#d97706",
  revision: "#0d9488",
  mock_test: "#e11d48",
};

const MONTHS = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
const LONG = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const shortDate = (d: string) => MONTHS.format(at(d));
export const weekday = (d: string) => WEEKDAY.format(at(d));
export const longDate = (d: string) => LONG.format(at(d));

/** "Today" / "Yesterday" / "Mon 12 Oct", relative to the student's own today (from the server). */
export function dayHeading(date: string, today: string): string {
  const diff = Math.round((at(today) - at(date)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : longDate(date);
}

/** Groups already-sorted events under their day, keeping order. */
export function groupByDay(events: ProgressActivity[]): Array<{ date: string; events: ProgressActivity[] }> {
  const groups: Array<{ date: string; events: ProgressActivity[] }> = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.date) last.events.push(e);
    else groups.push({ date: e.date, events: [e] });
  }
  return groups;
}

export const clockTime = (iso: string, timezone: string) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(iso));
  } catch {
    return "";
  }
};
