import { useEffect, useMemo, useState } from "react";
import type { StudySession } from "@copilot/shared";
import { ActivityBadge, SessionStatusBadge } from "./Badges";
import { addDays, formatMedium, isoWeekday, weekLabel, weekStart } from "./dates";
import { formatMinutes, isVisible } from "./format";

interface Props {
  sessions: StudySession[];
  startDate: string;
  examDate: string;
  today: string;
  studyDays: number[];
  /** A date to show (e.g. the session opened from the dashboard). */
  focusDate?: string | null;
  onOpen: (session: StudySession) => void;
}

const clamp = (d: string, lo: string, hi: string) => (d < lo ? lo : d > hi ? hi : d);

/** One week at a time: seven columns on wide screens, a list of days on phones. */
export function WeekView({ sessions, startDate, examDate, today, studyDays, focusDate, onOpen }: Props) {
  const first = weekStart(startDate);
  const last = weekStart(examDate);
  const [week, setWeek] = useState(() => clamp(weekStart(focusDate ?? today), first, last));
  useEffect(() => {
    if (focusDate) setWeek(clamp(weekStart(focusDate), first, last));
  }, [focusDate, first, last]);

  const byDay = useMemo(() => {
    const map = new Map<string, StudySession[]>();
    for (const s of sessions) if (isVisible(s)) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [sessions]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const weekMinutes = days.reduce((m, d) => m + (byDay.get(d) ?? []).reduce((x, s) => x + s.durationMinutes, 0), 0);

  return (
    <section aria-labelledby="week-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="week-heading" className="text-base font-semibold text-slate-900">
            Week of {weekLabel(week)}
          </h2>
          <p className="text-xs text-slate-600">{weekMinutes > 0 ? `${formatMinutes(weekMinutes)} planned this week` : "Nothing planned this week"}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setWeek(addDays(week, -7))} disabled={week <= first} aria-label="Previous week" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-40">
            <span aria-hidden="true">←</span>
          </button>
          <button type="button" onClick={() => setWeek(clamp(weekStart(today), first, last))} className="h-10 rounded-lg px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">
            This week
          </button>
          <button type="button" onClick={() => setWeek(addDays(week, 7))} disabled={week >= last} aria-label="Next week" className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-40">
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <ol className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-7">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const isToday = d === today;
          const isExam = d === examDate;
          const outside = d < startDate || d > examDate;
          const rest = !outside && !isExam && list.length === 0 && !studyDays.includes(isoWeekday(d));
          return (
            <li key={d} aria-label={`${formatMedium(d)}${isToday ? ", today" : ""}${isExam ? ", exam day" : ""}`} className={`min-w-0 rounded-xl p-2.5 ring-1 lg:min-h-40 ${isToday ? "bg-brand-50/60 ring-2 ring-brand-600" : outside ? "bg-slate-50/60 ring-slate-100" : "bg-white ring-slate-200"}`}>
              <div className="flex items-center justify-between gap-1">
                <span className={`text-xs font-semibold ${isToday ? "text-brand-800" : "text-slate-700"}`}>{formatMedium(d)}</span>
                {isToday && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Today</span>}
                {isExam && <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Exam</span>}
              </div>
              {list.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {list.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(s)}
                        className={`w-full rounded-lg p-2 text-left ring-1 transition hover:ring-brand-400 focus-visible:outline-2 focus-visible:outline-brand-600 ${s.effectiveStatus === "completed" ? "bg-emerald-50/60 ring-emerald-200" : s.effectiveStatus === "missed" ? "bg-red-50/50 ring-red-200" : s.effectiveStatus === "skipped" ? "bg-slate-50 ring-slate-200" : "bg-white ring-slate-200"}`}
                      >
                        <span className="flex flex-wrap items-center gap-1">
                          <ActivityBadge type={s.activityType} />
                          {s.effectiveStatus !== "planned" && <SessionStatusBadge status={s.effectiveStatus} />}
                        </span>
                        <span className={`mt-1 block break-words text-sm font-medium leading-snug text-slate-900 ${s.effectiveStatus === "skipped" ? "line-through decoration-slate-400" : ""}`}>{s.topic}</span>
                        <span className="block text-xs text-slate-600">
                          {s.subject} · {s.startTime ? `${s.startTime} · ` : ""}
                          {formatMinutes(s.durationMinutes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-slate-500">{isExam ? "Good luck!" : rest ? "Rest day" : outside ? "Outside your plan" : "No sessions"}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
