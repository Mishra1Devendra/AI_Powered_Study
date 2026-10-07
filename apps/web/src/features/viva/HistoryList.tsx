import { Link } from "react-router";
import type { VivaListResponse } from "@copilot/shared";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { DifficultyBadge, ProvenanceBadge, ScoreBadge, SourceBadge, StatusBadge } from "./Badges";
import { shortDate, title } from "./format";
import { useVivaPaths } from "./paths";

/** The student's own vivas, newest first. A completed one opens its results; an unfinished one can be continued. */
export function HistoryList({ data }: { data: VivaListResponse }) {
  const p = useVivaPaths();
  return (
    <Section title="Your vivas">
      {data.sessions.length > 0 ? (
        <>
          {data.summary.completed > 0 && (
            <p className="-mt-2 mb-3 text-sm text-slate-600">
              {data.summary.completed} completed · average score {Math.round(data.summary.averageScore ?? 0)}%
            </p>
          )}
          <ul className="grid gap-2 md:grid-cols-2">
            {data.sessions.map((s) => (
              <li key={s.id}>
                <Link to={p.session(s.id)} className="block rounded-xl bg-white p-4 ring-1 ring-slate-200 transition hover:ring-brand-400 focus-visible:outline-2 focus-visible:outline-brand-600">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-words font-semibold text-slate-900">{s.subject}</span>
                    {s.status === "completed" && s.score !== null ? <ScoreBadge score={s.score} /> : <StatusBadge status={s.status} />}
                  </div>
                  {s.topic && <p className="break-words text-sm text-slate-700">{s.topic}</p>}
                  <p className="mt-1 text-xs text-slate-600">
                    {s.status === "completed" ? `${s.questionCount} questions` : `${s.answeredCount} of ${s.questionCount} answered`} · {shortDate(s.startedAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <DifficultyBadge d={s.difficulty} />
                    <SourceBadge sourceType={s.sourceType} documentTitle={s.documentTitle} />
                    {s.status === "in_progress" && <span className="text-xs font-medium text-brand-700">Continue →</span>}
                    {s.isMock && <ProvenanceBadge isMock model={null} />}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <SectionEmpty title="No vivas yet">Your completed vivas, with their scores and every question, are kept here.</SectionEmpty>
      )}
    </Section>
  );
}
