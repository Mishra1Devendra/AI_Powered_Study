import { useContext } from "react";
import { Link } from "react-router";
import type { Dashboard, Recommendation } from "@copilot/shared";
import { isBuilt } from "../../components/layout/nav";
import { ArrowRightIcon } from "../../components/ui/Icons";
import { LinkButton } from "../../components/ui/LinkButton";
import { DEFAULT_RECO_BASES, RecoBaseContext, actionTarget, type RecoBases } from "../recommendations/paths";

export interface NextStep {
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  to: string;
  /** Navigation state for the destination (only the Tutor uses it: a suggested question that is NOT sent). */
  state?: unknown;
  /** Where the suggestion came from, so the screen can say so. */
  source: "resume" | "plan" | "continue" | "recommendation" | "empty";
}

/**
 * Decides the single most useful next action from real data only:
 *   what the API says to resume (an in-progress session, an unfinished quiz or viva, today's next session, recent activity)
 *   -> today's plan -> continue-learning -> the top recommendation -> a start-here prompt.
 */
export function nextStep(d: Dashboard, recommendation: Recommendation | null = null, bases: RecoBases = DEFAULT_RECO_BASES): NextStep {
  if (d.resume) {
    return { eyebrow: d.resume.eyebrow, title: d.resume.title, description: d.resume.detail ?? "", cta: d.resume.cta, to: d.resume.href, source: "resume" };
  }
  const active = d.plan.find((p) => p.status === "in_progress");
  if (active) {
    return { eyebrow: "In progress", title: `Continue ${active.topic}`, description: `${active.subject} · ${active.durationMinutes} min planned`, cta: "Continue session", to: active.href, source: "plan" };
  }
  const next = d.plan.find((p) => p.status === "todo");
  if (next) {
    return { eyebrow: "Up next today", title: `Start ${next.topic}`, description: `${next.subject} · ${next.durationMinutes} min planned`, cta: "Start session", to: next.href, source: "plan" };
  }
  if (d.continueLearning) {
    const c = d.continueLearning;
    return { eyebrow: "Pick up where you left off", title: c.topic, description: `${c.subject} · ${Math.round(c.progressPercent)}% complete`, cta: "Continue learning", to: c.href, source: "continue" };
  }
  if (recommendation) {
    const action = recommendation.actions.find((a) => a.kind === recommendation.primary) ?? recommendation.actions[0]!;
    const target = actionTarget(bases, action);
    return { eyebrow: "Recommended for you", title: recommendation.title, description: recommendation.reason, cta: action.label, to: target.to, ...(target.state !== undefined ? { state: target.state } : {}), source: "recommendation" };
  }
  return {
    eyebrow: "What should I study today?",
    title: "Start with a question for your AI tutor",
    description: "Ask about anything you are studying. Your progress, weak topics and plan build up as you learn.",
    cta: "Ask the AI Tutor",
    to: "/tutor",
    source: "empty",
  };
}

const CYCLE = [
  { label: "Learn", to: "/tutor" },
  { label: "Practice", to: "/notes" },
  { label: "Test", to: "/quiz" },
  { label: "Analyze", to: "/progress" },
  { label: "Improve", to: "/study-plan" },
] as const;

/** The day's single focus ("Continue learning"), plus the learning cycle the whole product follows. */
export function FocusCard({ dashboard, recommendation = null }: { dashboard: Dashboard; recommendation?: Recommendation | null }) {
  const bases = useContext(RecoBaseContext);
  const step = nextStep(dashboard, recommendation, bases);
  return (
    <section aria-labelledby="focus-title" className="palette-light hero-surface rounded-(--radius-card) p-6 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#e8c25c]">{step.eyebrow}</p>
      <h2 id="focus-title" className="mt-2 max-w-xl font-display text-2xl font-semibold leading-snug tracking-tight sm:text-[1.9rem]">
        {step.title}
      </h2>
      {step.description && <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/75 sm:text-base">{step.description}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <LinkButton to={step.to} {...(step.state !== undefined ? { state: step.state } : {})} className="!bg-white !text-[#14213f] !shadow-md hover:!bg-[#f3e2b0]">
          {step.cta}
          <ArrowRightIcon className="h-4 w-4" />
        </LinkButton>
        {step.source === "empty" && (
          <LinkButton to="/notes" variant="secondary" className="!bg-transparent !text-white !ring-white/30 hover:!bg-white/10">
            Upload notes
          </LinkButton>
        )}
      </div>
      {step.source === "recommendation" && <p className="mt-3 text-xs text-white/60">Opens the screen with this ready. Nothing starts until you press the button there.</p>}

      <nav aria-label="Learning cycle" className="mt-8 border-t border-white/10 pt-5">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          {CYCLE.map((s, i) => (
            <li key={s.label} className="flex items-center gap-2">
              <Link
                to={s.to}
                className="inline-flex h-9 items-center rounded-full bg-white/10 px-3.5 font-medium text-white/90 ring-1 ring-white/10 transition hover:bg-white/20"
              >
                {s.label}
                {!isBuilt(s.to) && <span className="sr-only"> (coming soon)</span>}
              </Link>
              {i < CYCLE.length - 1 && (
                <span aria-hidden="true" className="text-white/40">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </section>
  );
}
