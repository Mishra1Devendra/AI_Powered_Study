import { useAuth } from "../../auth/AuthProvider";
import { useAiUsageState } from "./store";

/** "about 3 hours" / "about 40 minutes" until the allowance starts again. */
export function resetPhrase(resetsAt: string, now: Date = new Date()): string {
  const minutes = Math.max(1, Math.ceil((new Date(resetsAt).getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * How much of today's AI allowance is left, and (when `cost` is given) what the action on this screen will use. Shown next to the
 * buttons that ask the AI for something; it shares the live numbers of the top-bar pill, so it updates the moment an AI action
 * happens. It never blocks anything itself - the server decides - and it stays silent if it cannot load. Administrators have no
 * limit, and see that instead of a count.
 */
export function AiUsageNote({ cost, className = "" }: { cost?: number; className?: string }) {
  const { client } = useAuth();
  const state = useAiUsageState(client);
  if (state.status !== "ready") return null;
  const usage = state.usage;

  if (usage.unlimited) {
    return (
      <p className={`rounded-xl bg-slate-50 px-4 py-2.5 text-sm text-slate-700 ring-1 ring-slate-200/70 ${className}`} data-testid="ai-usage">
        Administrator account: no daily AI limit.
      </p>
    );
  }

  const limit = usage.limit ?? 0;
  const left = usage.remaining ?? 0;
  const out = left === 0 || (cost !== undefined && left < cost);
  const pct = limit > 0 ? Math.min(100, Math.round((usage.used / limit) * 100)) : 0;
  return (
    <div className={`rounded-xl px-4 py-3 text-sm ring-1 ${out ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-slate-50 text-slate-700 ring-slate-200/70"} ${className}`} data-testid="ai-usage">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p>
          <span className="font-semibold tabular-nums">{left}</span> of <span className="tabular-nums">{limit}</span> AI uses left today
          {cost !== undefined && <span className="text-slate-600"> · this uses {cost}</span>}
        </p>
        <p className="text-xs text-slate-500">Starts again in {resetPhrase(usage.resetsAt)}</p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="AI uses spent today" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={usage.used}>
        <div className={`h-full rounded-full ${out ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
      </div>
      {out && <p className="mt-2 font-medium">{left === 0 ? "You've used all of today's AI. Everything that doesn't use AI still works." : `You don't have enough AI uses left for this today (it needs ${cost}).`}</p>}
    </div>
  );
}
