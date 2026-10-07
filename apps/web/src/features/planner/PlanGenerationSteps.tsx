import type { PlanProgress } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";

export const PLAN_STEPS = [
  { stage: "preparing", label: "Preparing your plan" },
  { stage: "analyzing", label: "Analyzing your schedule" },
  { stage: "scheduling", label: "Creating study sessions" },
  { stage: "checking", label: "Checking your plan" },
  { stage: "saving", label: "Saving your plan" },
] as const;

/**
 * The real stages of plan creation, as reported by the job on the server. No estimate and no percentage:
 * before the server has reported a stage, it says so instead of guessing.
 */
export function PlanGenerationSteps({ progress }: { progress: PlanProgress | null | undefined }) {
  const current = progress ? PLAN_STEPS.findIndex((s) => s.stage === progress.stage) : -1;
  return (
    <div>
      <p role="status" aria-live="polite" className="text-lg font-semibold tracking-tight text-slate-900">
        {current >= 0 ? `${PLAN_STEPS[current]!.label}…` : "Creating your plan…"}
      </p>
      {progress?.stage === "analyzing" && <p className="mt-1 text-sm text-slate-700">The local AI is choosing topics for your subjects. On a slower computer this can take a few minutes.</p>}
      <ol aria-label="Plan creation steps" className="mt-4 space-y-2.5">
        {PLAN_STEPS.map((step, i) => {
          const done = current > i;
          const active = current === i;
          return (
            <li key={step.stage} aria-current={active ? "step" : undefined} className={`flex items-center gap-3 text-sm ${active ? "font-semibold text-slate-900" : done ? "text-slate-700" : "text-slate-500"}`}>
              <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ${done ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : active ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-slate-400 ring-slate-200"}`}>
                {done ? (
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8.5l3.2 3L13 4.5" />
                  </svg>
                ) : active ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </span>
              <span>
                {step.label}
                <span className="sr-only">{done ? " (done)" : active ? " (in progress)" : " (waiting)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
