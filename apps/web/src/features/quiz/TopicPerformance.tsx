import type { TopicPerformance as Topic } from "@copilot/shared";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { formatPercent, scoreBand } from "./format";

const barColor = (p: number) => (p >= 80 ? "var(--color-emerald-600)" : p >= 50 ? "var(--color-amber-500)" : "var(--color-red-500)");

/** Accuracy per topic, from this attempt's real answers. Weakest first. */
export function TopicPerformance({ topics }: { topics: Topic[] }) {
  if (topics.length === 0) return null;
  return (
    <section aria-label="Performance by topic" className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <h2 className="text-base font-semibold tracking-tight text-slate-900">Performance by topic</h2>
      <p className="text-xs text-slate-600">Weakest first. Unanswered questions count as not correct.</p>
      <ul className="mt-4 space-y-4">
        {topics.map((t) => {
          const name = t.topic ?? "Unclassified";
          return (
            <li key={t.topic ?? "(none)"}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 break-words font-medium text-slate-800">{name}</span>
                <span className="shrink-0 text-slate-700">
                  {t.correct}/{t.total} · {formatPercent(t.percentage)} <span className={`text-xs font-medium ${scoreBand(t.percentage).classes}`}>{scoreBand(t.percentage).label}</span>
                </span>
              </div>
              <ProgressBar value={t.percentage} color={barColor(t.percentage)} label={`${name}: ${t.correct} of ${t.total} correct`} className="mt-1.5" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
