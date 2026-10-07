import { Link } from "react-router";
import type { StudyPlan } from "@copilot/shared";
import { PlanProvenance, PlanStatusBadge } from "./Badges";
import { formatMedium } from "./dates";
import { usePlannerPaths } from "./paths";

/** Earlier plans are never deleted: they stay here with their real progress. */
export function PreviousPlans({ plans }: { plans: StudyPlan[] }) {
  const p = usePlannerPaths();
  if (plans.length === 0) return null;
  return (
    <section aria-labelledby="previous-heading">
      <h2 id="previous-heading" className="text-base font-semibold text-slate-900">
        Previous plans
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {plans.map((plan) => (
          <li key={plan.id}>
            <Link to={p.plan(plan.id)} className="block rounded-xl bg-white p-4 ring-1 ring-slate-200 transition hover:ring-brand-400 focus-visible:outline-2 focus-visible:outline-brand-600">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words font-medium text-slate-900">{plan.title}</span>
                <PlanStatusBadge status={plan.status} />
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Exam {formatMedium(plan.examDate)} · created {formatMedium(plan.createdAt.slice(0, 10))}
                {plan.status === "archived" && ` · ${plan.stats.completed} of ${plan.stats.totalSessions} sessions completed`}
              </p>
              {plan.status !== "failed" && (
                <div className="mt-2">
                  <PlanProvenance isMock={plan.isMock} model={plan.model} />
                </div>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
