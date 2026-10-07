import { Link } from "react-router";
import type { AttemptHistoryItem } from "@copilot/shared";
import { formatDate } from "../notes/format";
import { useQuizPaths } from "./paths";
import { ATTEMPT_STATUS_LABEL, DIFFICULTY_LABEL, formatPercent, scoreBand } from "./format";

/** Every attempt, newest first, including retries of the same quiz. */
export function HistoryList({ attempts }: { attempts: AttemptHistoryItem[] }) {
  const p = useQuizPaths();
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
      {attempts.map((a) => {
        const done = a.status !== "in_progress" && a.percentage !== null;
        const band = done ? scoreBand(a.percentage!) : null;
        return (
          <li key={a.id}>
            <Link to={done ? p.result(a.id) : p.attempt(a.id)} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3.5 hover:bg-slate-50 sm:px-5">
              <span className="min-w-0">
                <span className="block break-words text-sm font-semibold text-slate-900">{a.quizTitle}</span>
                <span className="block text-sm text-slate-600">
                  {a.sourceLabel} · {DIFFICULTY_LABEL[a.difficulty]} · {a.questionCount} questions · {formatDate(a.submittedAt ?? a.startedAt)}
                </span>
              </span>
              <span className="text-right">
                {done ? (
                  <>
                    <span className="block text-base font-semibold text-slate-900">
                      {a.score}/{a.total} · {formatPercent(a.percentage!)}
                    </span>
                    <span className={`block text-xs font-medium ${band!.classes}`}>
                      {band!.label} · {ATTEMPT_STATUS_LABEL[a.status]}
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-sky-800 ring-1 ring-sky-200">Resume</span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
