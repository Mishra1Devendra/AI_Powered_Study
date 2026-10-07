import { Link } from "react-router";
import { PROGRESS_RANGES, RANGE_LABEL, type ProgressActivity, type ProgressRange, type ProgressResponse } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { Alert } from "../../components/ui/Alert";
import { clockTime, dayHeading, groupByDay } from "./format";
import { StartLinks } from "./TopicSections";

/** 7 / 30 / 90 days / all time. Choosing one reloads only the numbers, not the page. */
export function RangeFilter({ value, onChange, busy }: { value: ProgressRange; onChange: (r: ProgressRange) => void; busy: boolean }) {
  return (
    <div role="group" aria-label="Date range" className="inline-flex rounded-xl bg-slate-100 p-1">
      {PROGRESS_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => r !== value && onChange(r)}
          className={`h-9 rounded-lg px-3 text-sm font-medium transition ${value === r ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-700 hover:text-slate-900"} ${busy && value !== r ? "opacity-70" : ""}`}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

const ICON: Record<ProgressActivity["type"], { path: string; classes: string; label: string }> = {
  session_completed: { path: "M3 8.5l3.2 3L13 4.5", classes: "bg-emerald-50 text-emerald-700", label: "Completed session" },
  session_skipped: { path: "M4 8h8", classes: "bg-slate-100 text-slate-600", label: "Skipped session" },
  quiz_completed: { path: "M3 5h10M3 8h10M3 11h6", classes: "bg-amber-50 text-amber-700", label: "Quiz" },
};

export function RecentActivitySection({ data }: { data: ProgressResponse }) {
  const groups = groupByDay(data.activity);
  return (
    <Section title="Recent activity">
      {groups.length > 0 ? (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.date}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{dayHeading(g.date, data.today)}</h3>
              <ul className="mt-2 divide-y divide-slate-100">
                {g.events.map((e) => {
                  const icon = ICON[e.type];
                  const body = (
                    <>
                      <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${icon.classes}`}>
                        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d={icon.path} />
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium text-slate-900">
                          <span className="sr-only">{icon.label}: </span>
                          {e.title}
                        </span>
                        <span className="block text-xs text-slate-600">
                          {e.detail}
                          {e.detail && " · "}
                          {clockTime(e.at, data.timezone)}
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={e.id}>{e.href ? <Link to={e.href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-slate-50">{body}</Link> : <div className="flex items-center gap-3 py-2.5">{body}</div>}</li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <SectionEmpty title="No activity yet">Completed sessions and finished quizzes show up here.</SectionEmpty>
      )}
    </Section>
  );
}

/** Page-level empty state: nothing has ever been recorded. */
export function NothingYet() {
  return (
    <Card className="mx-auto max-w-2xl text-center">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">No study data yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">Start your first study session or take a quiz. Your study time, quiz scores, streak and topic strengths are worked out from what you actually do, so nothing appears here until you do.</p>
      <div className="mt-6">
        <StartLinks />
      </div>
    </Card>
  );
}

export function ProgressSkeleton() {
  const bar = (cls: string) => <div className={`animate-pulse rounded-lg bg-slate-200/80 ${cls}`} />;
  return (
    <div role="status" aria-label="Loading your progress" className="space-y-6">
      <span className="sr-only">Loading your progress…</span>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            {bar("h-9 w-9")}
            {bar("mt-4 h-8 w-24")}
            {bar("mt-3 h-4 w-40")}
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          {bar("h-5 w-32")}
          {bar("mt-4 h-48 w-full")}
        </Card>
        <Card>
          {bar("h-5 w-32")}
          {bar("mt-4 h-32 w-full")}
        </Card>
      </div>
    </div>
  );
}

export function ProgressError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md space-y-3 py-10 text-center">
      <Alert tone="error">We couldn&apos;t load your progress.</Alert>
      <p className="text-sm text-slate-600">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
