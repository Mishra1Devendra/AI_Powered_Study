import type { GenerationProgress } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";

const STEPS = [
  { stage: "preparing", label: "Preparing quiz…" },
  { stage: "generating", label: "Generating questions…" },
  { stage: "checking", label: "Checking questions…" },
  { stage: "finalizing", label: "Finalizing quiz…" },
] as const;

/** One-line description of what is happening right now. Only facts the server reported. */
export function describeProgress(p: GenerationProgress | null | undefined): string {
  if (!p) return "Creating your quiz…";
  switch (p.stage) {
    case "preparing":
      return "Preparing quiz…";
    case "generating":
      return p.batch > 1 ? "Generating replacements for questions that did not pass the checks…" : "Generating questions…";
    case "checking":
      return "Checking questions…";
    case "finalizing":
      return "Finalizing quiz…";
  }
}

/**
 * The four stages a quiz goes through, with the one that is running now. These come from the real job
 * on the server - there is no estimate and no percentage. Before the server has reported anything (for
 * example just after the page opens) it says so instead of guessing.
 */
export function GenerationSteps({ progress }: { progress: GenerationProgress | null | undefined }) {
  const current = progress ? STEPS.findIndex((s) => s.stage === progress.stage) : -1;
  return (
    <div>
      <p role="status" aria-live="polite" className="text-lg font-semibold tracking-tight text-slate-900">
        {describeProgress(progress)}
      </p>
      {progress && progress.stage !== "preparing" && (
        <p className="mt-1 text-sm text-slate-700">
          {progress.accepted} of {progress.target} questions have passed the checks so far.
        </p>
      )}
      <ol aria-label="Quiz creation steps" className="mt-4 space-y-2.5">
        {STEPS.map((step, i) => {
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
