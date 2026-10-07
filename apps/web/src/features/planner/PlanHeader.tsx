import type { StudyPlan } from "@copilot/shared";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { PlanProvenance, PlanStatusBadge } from "./Badges";
import { daysBetween, formatLong } from "./dates";
import { LEVEL_LABEL, TIME_LABEL, formatMinutes } from "./format";
import { WEEKDAY_SHORT } from "@copilot/shared";

/** Name, exam date, days left, target, status - and progress only from real completed sessions. */
export function PlanHeader({ plan, today }: { plan: StudyPlan; today: string }) {
  const left = daysBetween(today, plan.examDate);
  const { completed, totalSessions, completedMinutes, plannedMinutes, missed, skipped } = plan.stats;
  const pct = totalSessions > 0 ? (completed / totalSessions) * 100 : 0;

  return (
    <header className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-slate-900">{plan.title}</h1>
          <p className="mt-1 text-sm text-slate-700">
            Exam on <strong>{formatLong(plan.examDate)}</strong>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PlanStatusBadge status={plan.status} />
          <PlanProvenance isMock={plan.isMock} model={plan.model} />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-xs text-slate-600">Days remaining</dt>
          <dd className="text-lg font-semibold text-slate-900">{left > 0 ? left : left === 0 ? "Exam today" : "Exam passed"}</dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-xs text-slate-600">Target score</dt>
          <dd className="text-lg font-semibold text-slate-900">{plan.targetScore !== null ? `${plan.targetScore}%` : "Not set"}</dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-xs text-slate-600">Study time</dt>
          <dd className="text-lg font-semibold text-slate-900">{formatMinutes(plan.minutesPerDay)}/day</dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-xs text-slate-600">Sessions</dt>
          <dd className="text-lg font-semibold text-slate-900">{totalSessions}</dd>
        </div>
      </dl>

      <div className="mt-4">
        {completed > 0 ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-slate-900">
                {completed} of {totalSessions} sessions completed
              </span>
              <span className="text-slate-600">
                {formatMinutes(completedMinutes)} of {formatMinutes(plannedMinutes)} studied
              </span>
            </div>
            <ProgressBar className="mt-2" value={pct} label="Sessions completed" />
          </>
        ) : (
          <p className="rounded-xl bg-brand-50 px-4 py-2.5 text-sm font-medium text-brand-900">Plan created — start your first session.</p>
        )}
        {(missed > 0 || skipped > 0) && (
          <p className="mt-2 text-xs text-slate-600">
            {missed > 0 && `${missed} missed`}
            {missed > 0 && skipped > 0 && " · "}
            {skipped > 0 && `${skipped} skipped`}
          </p>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-600">
        {LEVEL_LABEL[plan.knowledgeLevel]} · {plan.studyDays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")} · {TIME_LABEL[plan.preferredTime]} · {plan.subjects.map((s) => s.name).join(", ")}
      </p>
      {plan.summary && <p className="mt-2 text-sm text-slate-700">{plan.summary}</p>}
      {plan.unscheduledTopics.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Not enough time for every topic before the exam. Not scheduled: {plan.unscheduledTopics.join("; ")}. Add more study days or time per day, then regenerate.
        </p>
      )}
    </header>
  );
}
