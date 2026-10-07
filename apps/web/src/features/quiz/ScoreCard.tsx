import type { QuizResult } from "@copilot/shared";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { formatDuration, formatPercent, scoreBand } from "./format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">{value}</dd>
    </div>
  );
}

/** The headline result. Every number here was calculated by the server. */
export function ScoreCard({ result }: { result: QuizResult }) {
  const a = result.attempt;
  const band = scoreBand(a.percentage);
  const attempted = a.correct + a.incorrect;
  const accuracy = attempted === 0 ? null : (a.correct / attempted) * 100;
  return (
    <section aria-label="Your score" className="relative overflow-hidden rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-8">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-500 via-violet-500 to-teal-400" />
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-10">
        <ProgressRing fraction={a.percentage / 100} size={156} label={`Score ${a.score} out of ${a.total}, ${formatPercent(a.percentage)}`}>
          <span className="text-3xl font-semibold tracking-tight text-slate-900">{formatPercent(a.percentage)}</span>
        </ProgressRing>
        <div className="text-center sm:text-left">
          <p className="text-sm font-medium text-slate-600">{result.quiz.title}</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight text-slate-900">
            {a.score} <span className="text-slate-500">/ {a.total}</span>
          </p>
          <p className={`mt-1 text-base font-semibold ${band.classes}`}>{band.label}</p>
          {a.timedOut && <p className="mt-2 inline-block rounded-lg bg-amber-50 px-3 py-1.5 text-sm text-amber-900">Time ran out. Your saved answers were submitted.</p>}
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Correct" value={String(a.correct)} />
        <Stat label="Incorrect" value={String(a.incorrect)} />
        <Stat label="Unanswered" value={String(a.unanswered)} />
        <Stat label="Accuracy" value={accuracy === null ? "—" : formatPercent(Math.round(accuracy * 10) / 10)} />
        <Stat label="Time taken" value={a.timeTakenSeconds === null ? "—" : formatDuration(a.timeTakenSeconds)} />
      </dl>
      {accuracy !== null && <p className="mt-2 text-xs text-slate-600">Accuracy counts only the questions you answered. Your score counts every question.</p>}
    </section>
  );
}
