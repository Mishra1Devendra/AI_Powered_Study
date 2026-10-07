import type { PlanItem } from "@copilot/shared";
import { CheckIcon, ClockIcon } from "../../components/ui/Icons";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { formatMinutes, subjectColor } from "./format";

const STATUS_LABEL = { todo: "To do", in_progress: "In progress", done: "Completed" } as const;

function PlanRow({ item }: { item: PlanItem }) {
  const done = item.status === "done";
  return (
    <li className="flex items-center gap-4 py-3.5">
      <span className="w-12 shrink-0 text-sm font-medium tabular-nums text-slate-500">{item.startTime ?? "Any time"}</span>
      <span aria-hidden="true" className="h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: subjectColor(item.subject) }} />
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${done ? "text-slate-500 line-through" : "text-slate-900"}`}>{item.topic}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-slate-600">
          <span>{item.subject}</span>
          <span className="inline-flex items-center gap-1">
            <ClockIcon className="h-3.5 w-3.5" />
            {formatMinutes(item.durationMinutes)}
          </span>
        </p>
      </div>
      {done ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
          <CheckIcon className="h-3.5 w-3.5" />
          {STATUS_LABEL.done}
        </span>
      ) : (
        <LinkButton
          to={item.href}
          size="sm"
          variant={item.status === "in_progress" ? "primary" : "secondary"}
          aria-label={`${item.status === "in_progress" ? "Continue" : "Start"} ${item.topic}`}
          className="shrink-0"
        >
          {item.status === "in_progress" ? "Continue" : "Start"}
        </LinkButton>
      )}
    </li>
  );
}

export function TodaysPlan({ plan }: { plan: PlanItem[] }) {
  const completed = plan.filter((p) => p.status === "done").length;
  const leftMinutes = plan.filter((p) => p.status !== "done").reduce((m, p) => m + p.durationMinutes, 0);
  return (
    <Section
      title="Today's focus"
      action={plan.length > 0 ? <span className="text-sm text-slate-500">{completed} of {plan.length} done</span> : undefined}
    >
      {plan.length > 0 ? (
        <>
        {leftMinutes > 0 && <p className="-mt-1 mb-1 text-sm text-slate-600">About {formatMinutes(leftMinutes)} of study left today.</p>}
        <ul className="divide-y divide-slate-100">
          {plan.map((item) => (
            <PlanRow key={item.id} item={item} />
          ))}
        </ul>
        </>
      ) : (
        <SectionEmpty
          title="No study plan for today"
          action={
            <LinkButton to="/study-plan" size="sm">
              Create a study plan
            </LinkButton>
          }
        >
          Tell us your exam date and subjects and we will build a plan around your week.
        </SectionEmpty>
      )}
    </Section>
  );
}
