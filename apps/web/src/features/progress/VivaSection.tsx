import type { ProgressResponse } from "@copilot/shared";
import { DIMENSIONS, DIMENSION_LABEL } from "@copilot/shared";
import { Link } from "react-router";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { Meter, ScoreBadge } from "../viva/Badges";
import { pct, shortDate } from "../viva/format";

/** Viva results, kept apart from the quiz numbers above. */
export function VivaSection({ data }: { data: ProgressResponse }) {
  const v = data.viva;
  return (
    <Section title="Viva performance">
      {v.sessionsCompleted > 0 && v.dimensions ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <p className="text-3xl font-semibold tracking-tight text-slate-900">
              {pct(v.averageScore)} <span className="text-base font-medium text-slate-600">average viva score</span>
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              {[
                ["Completed", String(v.sessionsCompleted)],
                ["Best", pct(v.bestScore)],
                ["Latest", pct(v.recentScore)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
                  <dt className="text-xs text-slate-600">{label}</dt>
                  <dd className="text-lg font-semibold text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
            <dl className="mt-4 space-y-2">
              {DIMENSIONS.map((d) => (
                <div key={d}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <dt className="text-slate-700">{DIMENSION_LABEL[d]}</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">{Math.round(v.dimensions![d])}%</dd>
                  </div>
                  <div className="mt-1">
                    <Meter value={v.dimensions![d]} label={`${DIMENSION_LABEL[d]}: ${Math.round(v.dimensions![d])} percent`} />
                  </div>
                </div>
              ))}
            </dl>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">By subject</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {v.bySubject.map((s) => (
                <li key={s.subject} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-800">
                    {s.subject} <span className="text-slate-500">· {s.sessions} {s.sessions === 1 ? "viva" : "vivas"}</span>
                  </span>
                  <ScoreBadge score={s.averageScore} />
                </li>
              ))}
            </ul>
            <h3 className="mt-5 text-sm font-semibold text-slate-900">Recent vivas</h3>
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {v.recent.map((r) => (
                <li key={r.id}>
                  <Link to={`/viva/${r.id}`} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
                    <span className="min-w-0 truncate text-slate-800">
                      {r.subject}
                      {r.topic ? ` — ${r.topic}` : ""} <span className="text-slate-500">· {shortDate(`${r.date}T12:00:00Z`)}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900">{Math.round(r.score)}%</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-600">AI-generated, advisory scores from your completed vivas. Quiz results are shown separately.</p>
          </div>
        </div>
      ) : (
        <SectionEmpty
          title="No completed viva yet"
          action={
            <LinkButton to="/viva" variant="secondary" size="sm">
              Start a viva
            </LinkButton>
          }
        >
          Finish an AI Viva{data.range === "all" ? "" : " in this period"} to see your viva scores here.
        </SectionEmpty>
      )}
    </Section>
  );
}
