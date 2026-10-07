import type { ReactNode } from "react";
import type { Today } from "@copilot/shared";
import { FlameIcon } from "../../components/ui/Icons";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { Section } from "../../components/ui/Section";
import { formatMinutes } from "./format";

function Stat({ label, value, hint, icon }: { label: string; value: string | null; hint: string; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-sm text-slate-600">
        {icon}
        {label}
      </dt>
      <dd className="mt-1">
        {value ? (
          <span className="text-2xl font-semibold tracking-tight text-slate-900">{value}</span>
        ) : (
          <span className="text-2xl font-semibold text-slate-500">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No data yet</span>
          </span>
        )}
        <span className="mt-0.5 block break-words text-xs text-slate-500">{hint}</span>
      </dd>
    </div>
  );
}

export function TodayProgress({ today }: { today: Today }) {
  const { studyMinutes, plannedMinutes, tasksCompleted, tasksPlanned, quizAveragePercent, streakDays } = today;
  const nothingTracked = Object.values(today).every((v) => v === null);
  const hasPlan = plannedMinutes !== null && plannedMinutes > 0;
  const fraction = hasPlan && studyMinutes !== null ? studyMinutes / plannedMinutes : 0;

  const ringLabel =
    studyMinutes === null
      ? "No study time recorded today"
      : hasPlan
        ? `${formatMinutes(studyMinutes)} studied of ${formatMinutes(plannedMinutes)} planned`
        : `${formatMinutes(studyMinutes)} studied today`;

  return (
    <Section title="Today's progress">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-10 lg:flex-col lg:items-stretch lg:gap-6">
        <div className="flex items-center gap-5 lg:justify-center">
          <ProgressRing fraction={fraction} label={ringLabel}>
            <span className="text-xl font-semibold tracking-tight text-slate-900">
              {studyMinutes === null ? "—" : formatMinutes(studyMinutes)}
            </span>
            <span className="text-xs text-slate-500">studied</span>
          </ProgressRing>
          <div className="text-sm text-slate-600 sm:hidden">
            {hasPlan ? `of ${formatMinutes(plannedMinutes)} planned` : "No planned time set"}
          </div>
        </div>
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4 lg:grid-cols-2">
          <Stat
            label="Planned"
            value={hasPlan ? formatMinutes(plannedMinutes) : null}
            hint={hasPlan ? "study time today" : "Create a plan to set a goal"}
          />
          <Stat
            label="Tasks done"
            value={tasksPlanned !== null && tasksCompleted !== null ? `${tasksCompleted}/${tasksPlanned}` : null}
            hint="from today's plan"
          />
          <Stat
            label="Quiz average"
            value={quizAveragePercent === null ? null : `${Math.round(quizAveragePercent)}%`}
            hint={quizAveragePercent === null ? "Take a quiz to see it" : "across recent quizzes"}
          />
          <Stat
            label="Streak"
            value={streakDays === null ? null : `${streakDays} ${streakDays === 1 ? "day" : "days"}`}
            hint={streakDays === null ? "Study today to start one" : "of consecutive study"}
            icon={<FlameIcon className="h-4 w-4 text-amber-500" />}
          />
        </dl>
      </div>
      {nothingTracked && (
        <p className="mt-6 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Nothing tracked yet today. Study time, tasks and quiz scores appear here as you learn.
        </p>
      )}
    </Section>
  );
}
