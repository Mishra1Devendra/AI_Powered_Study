import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { SparkIcon } from "../../components/ui/Icons";
import { resetPhrase } from "./AiUsageNote";
import { useAiUsageState } from "./store";

/** Remaining share at or below which the pill turns amber. */
const LOW_SHARE = 0.2;

/**
 * The live "AI uses left today" pill for the top right of the app, shown on the screens that ask the AI for something. It updates the
 * moment an AI action happens (and flashes once so the change is noticed), and links to Settings for the details. Administrators
 * have no limit and see that. Silent while loading or if the numbers cannot be loaded: it never gets in the way.
 */
export function AiUsageBadge() {
  const { client } = useAuth();
  const state = useAiUsageState(client);
  const used = state.status === "ready" ? state.usage.used : null;
  const previous = useRef<number | null>(null);
  const [flash, setFlash] = useState(0);

  // A change of the number (after the first load) flashes the pill once.
  useEffect(() => {
    if (used === null) return;
    if (previous.current !== null && previous.current !== used) setFlash((n) => n + 1);
    previous.current = used;
  }, [used]);

  if (state.status !== "ready") return null;
  const u = state.usage;

  if (u.unlimited) {
    return (
      <Link to="/settings" aria-label="AI use: no limit for administrators" title="Administrator account: no daily AI limit" className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-200/70">
        <SparkIcon className="h-4 w-4 text-brand-600" />
        <span>
          AI <span className="hidden sm:inline">·</span> <span className="hidden sm:inline">Unlimited</span>
          <span className="sm:hidden" aria-hidden="true">∞</span>
        </span>
      </Link>
    );
  }

  const limit = u.limit ?? 0;
  const left = u.remaining ?? 0;
  const share = limit > 0 ? left / limit : 0;
  const out = left === 0;
  const low = !out && share <= LOW_SHARE;
  const tone = out ? "bg-red-50 text-red-800 ring-red-200 hover:bg-red-100" : low ? "bg-amber-50 text-amber-900 ring-amber-200 hover:bg-amber-100" : "bg-slate-100 text-slate-700 ring-slate-200 hover:bg-slate-200/70";
  const bar = out ? "bg-red-500" : low ? "bg-amber-500" : "bg-brand-600";
  const detail = `${left} of ${limit} AI uses left today. Starts again in ${resetPhrase(u.resetsAt)}.`;

  return (
    <>
      <Link
        to="/settings"
        // `key` restarts the one-off flash animation each time the number changes.
        key={flash}
        aria-label={`AI uses left today: ${left} of ${limit}`}
        title={`${detail} Click for details.`}
        data-testid="ai-usage-badge"
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs sm:px-3 font-semibold tabular-nums ring-1 transition ${tone} ${flash > 0 ? "ai-flash" : ""}`}
      >
        <SparkIcon className={`h-4 w-4 ${out ? "text-red-600" : low ? "text-amber-600" : "text-brand-600"}`} />
        <span>
          {left}
          <span className="hidden font-normal opacity-70 sm:inline">/{limit}</span>
          <span className="hidden font-normal opacity-70 md:inline"> AI uses</span>
        </span>
        <span aria-hidden="true" className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-black/10 sm:block dark:bg-white/15">
          <span className={`block h-full rounded-full transition-all duration-500 ${bar}`} style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      </Link>
      <span className="sr-only" role="status" aria-live="polite">
        {out ? "You have no AI uses left today." : low ? `Only ${left} AI uses left today.` : ""}
      </span>
    </>
  );
}
