import type { QuizSummary } from "@copilot/shared";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { formatPercent, scoreBand } from "./format";

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-0.5">
        {value ? (
          <span className="text-2xl font-semibold tracking-tight text-slate-900">{value}</span>
        ) : (
          <span className="text-2xl font-semibold text-slate-500">
            <span aria-hidden="true">—</span>
            <span className="sr-only">No data yet</span>
          </span>
        )}
        {hint && <span className="block text-xs text-slate-600">{hint}</span>}
      </dd>
    </div>
  );
}

const barColor = (p: number) => (p >= 80 ? "var(--color-emerald-600)" : p >= 50 ? "var(--color-amber-500)" : "var(--color-red-500)");

/** Real numbers from the student's finished attempts only. With none, it says so instead of showing zeros. */
export function PerformanceSummary({ summary }: { summary: QuizSummary }) {
  const none = summary.attemptsCompleted === 0;
  return (
    <section aria-label="Your quiz performance" className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <h2 className="text-base font-semibold tracking-tight text-slate-900">Your performance</h2>
      <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Quizzes taken" value={none ? null : String(summary.attemptsCompleted)} />
        <Stat label="Average score" value={summary.averagePercentage === null ? null : formatPercent(summary.averagePercentage)} />
        <Stat label="Best score" value={summary.bestPercentage === null ? null : formatPercent(summary.bestPercentage)} />
        <Stat label="Questions answered" value={none ? null : String(summary.questionsAnswered)} />
      </dl>

      {none ? (
        <p className="mt-4 text-sm text-slate-600">Take your first quiz and your results, strengths and weak spots will appear here.</p>
      ) : (
        summary.topics.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-slate-900">By topic</h3>
            <p className="text-xs text-slate-600">Weakest first, across all your finished quizzes.</p>
            <ul className="mt-3 space-y-3">
              {summary.topics.slice(0, 6).map((t) => (
                <li key={t.topic ?? "(none)"}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-medium text-slate-800">{t.topic ?? "Unclassified"}</span>
                    <span className="shrink-0 text-slate-600">
                      {t.correct}/{t.total} · {formatPercent(t.percentage)} <span className="sr-only">({scoreBand(t.percentage).label})</span>
                    </span>
                  </div>
                  <ProgressBar value={t.percentage} color={barColor(t.percentage)} label={`${t.topic ?? "Unclassified"}: ${formatPercent(t.percentage)} correct`} className="mt-1.5" />
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </section>
  );
}
