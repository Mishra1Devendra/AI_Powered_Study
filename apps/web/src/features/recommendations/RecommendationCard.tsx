import { Link, useNavigate } from "react-router";
import { TYPE_LABEL, type Recommendation, type RecommendationAction, type RecommendationType } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { useRecoPaths } from "./paths";

/** An icon, an accent and a short phrase per type. The type is always written out too: colour is only a reinforcement. */
const STYLE: Record<RecommendationType, { icon: string; accent: string; ring: string; tag: string }> = {
  URGENT_REVISION: { icon: "M12 3c1 3.5 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 1.5-4.5C10 9 11 10 12 10c1-2 0-4 0-7z", accent: "bg-red-50 text-red-700", ring: "ring-red-200", tag: "bg-red-50 text-red-800" },
  WEAK_TOPIC: { icon: "M12 8v5M12 16.5v.5M12 3l9 16H3z", accent: "bg-amber-50 text-amber-700", ring: "ring-amber-200", tag: "bg-amber-50 text-amber-900" },
  REPEATED_MISTAKE: { icon: "M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5", accent: "bg-orange-50 text-orange-700", ring: "ring-orange-200", tag: "bg-orange-50 text-orange-900" },
  PRACTICE_MORE: { icon: "M5 12.5l4.5 4.5L19 7.5", accent: "bg-sky-50 text-sky-700", ring: "ring-sky-200", tag: "bg-sky-50 text-sky-900" },
  VIVA_PRACTICE: { icon: "M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3", accent: "bg-violet-50 text-violet-700", ring: "ring-violet-200", tag: "bg-violet-50 text-violet-900" },
  UPCOMING_STUDY: { icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4", accent: "bg-brand-50 text-brand-700", ring: "ring-brand-200", tag: "bg-brand-50 text-brand-800" },
  IMPROVING: { icon: "M4 17l6-6 4 4 6-8M15 7h5v5", accent: "bg-emerald-50 text-emerald-700", ring: "ring-emerald-200", tag: "bg-emerald-50 text-emerald-800" },
  MAINTAIN_STRENGTH: { icon: "M12 3l2.5 5.5 6 .8-4.3 4.2 1 6-5.2-2.8L6.8 19.5l1-6L3.5 9.3l6-.8z", accent: "bg-teal-50 text-teal-700", ring: "ring-teal-200", tag: "bg-teal-50 text-teal-800" },
};

const PRIORITY_TEXT = { high: "High priority", medium: "Medium priority", low: "Low priority" } as const;

/** One button for one action: a real link where the destination is a screen, and a navigation (with the suggested question) for the Tutor. */
export function ActionButton({ action, primary, topicLabel }: { action: RecommendationAction; primary: boolean; topicLabel: string }) {
  const p = useRecoPaths();
  const navigate = useNavigate();
  const href = p.href(action);
  const label = `${action.label}${topicLabel ? `: ${topicLabel}` : ""}`;
  const cls = `inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-medium transition-colors ${primary ? "bg-brand-600 text-white shadow-sm hover:bg-brand-700" : "bg-white text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50"}`;
  if (href) {
    return (
      <Link to={href} className={cls} aria-label={label}>
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      variant={primary ? "primary" : "secondary"}
      className="h-11 px-4"
      aria-label={label}
      onClick={() => navigate(p.tutor, { state: { draft: action.draft ?? "", ...(action.subject ? { subject: action.subject } : {}), ...(action.topic ? { topic: action.topic } : {}) } })}
    >
      {action.label}
    </Button>
  );
}

/** The recommendation card: what, why (from the student's own facts), the suggested action and the buttons. */
export function RecommendationCard({ rec, aiText }: { rec: Recommendation; aiText?: string | undefined }) {
  const s = STYLE[rec.type];
  const topic = rec.topic ?? "";
  const ordered = [...rec.actions].sort((a, b) => Number(b.kind === rec.primary) - Number(a.kind === rec.primary));
  return (
    <article aria-label={rec.title} className={`rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ${rec.priority === "high" ? s.ring : "ring-slate-200/70"} sm:p-6`}>
      <div className="flex items-start gap-3.5">
        <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${s.accent}`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={s.icon} />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.tag}`}>{TYPE_LABEL[rec.type]}</span>
            <span className="text-xs font-medium text-slate-600">{PRIORITY_TEXT[rec.priority]}</span>
            {rec.subject && <span className="text-xs text-slate-500">· {rec.subject}</span>}
          </div>
          <h3 className="mt-1.5 break-words text-lg font-semibold leading-snug tracking-tight text-slate-900">{rec.title}</h3>
        </div>
      </div>

      <div className="mt-4 space-y-3 text-sm">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Why</h4>
          <p className="mt-1 leading-relaxed text-slate-800">{rec.reason}</p>
        </div>
        {aiText && (
          <div className="rounded-xl bg-brand-50/70 px-3.5 py-2.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-800">In plain words (AI)</h4>
            <p className="mt-1 leading-relaxed text-slate-800">{aiText}</p>
          </div>
        )}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Recommended action</h4>
          <p className="mt-1 font-medium text-slate-900">{rec.actionText}</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {ordered.map((a, i) => (
          <ActionButton key={`${a.kind}-${i}`} action={a} primary={i === 0} topicLabel={topic} />
        ))}
      </div>
    </article>
  );
}
