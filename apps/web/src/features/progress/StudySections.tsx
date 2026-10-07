import { ACTIVITY_LABEL, RANGE_LABEL, type ProgressResponse } from "@copilot/shared";
import { LinkButton } from "../../components/ui/LinkButton";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { StudyTimeChart } from "./charts";
import { ACTIVITY_COLOR, formatMinutes } from "./format";
import { useProgressPaths } from "./paths";

export function StudyTimeSection({ data }: { data: ProgressResponse }) {
  const p = useProgressPaths();
  const st = data.studyTime;
  return (
    <Section title="Time studied" className="h-full">
      {st.completedSessions > 0 ? (
        <>
          <p className="-mt-2 mb-3 text-sm text-slate-600">
            {formatMinutes(st.totalMinutes)} over {st.activeDays} study {st.activeDays === 1 ? "day" : "days"}
            {st.averageMinutesPerActiveDay !== null && ` · about ${formatMinutes(st.averageMinutesPerActiveDay)} on days you studied`}
          </p>
          <StudyTimeChart data={st} />
        </>
      ) : (
        <SectionEmpty
          title="No study data yet"
          action={
            <LinkButton to={p.studyPlan} variant="secondary" size="sm">
              Start your first study session
            </LinkButton>
          }
        >
          Study time comes from the sessions you mark complete in your study plan.
        </SectionEmpty>
      )}
    </Section>
  );
}

/** Planned vs completed, from the study plan. Sessions that are still to come are not counted against the student. */
export function ConsistencySection({ data }: { data: ProgressResponse }) {
  const st = data.studyTime;
  const due = st.completedSessions + st.skippedSessions + st.missedSessions;
  return (
    <Section title="Study consistency" className="h-full">
      {due > 0 ? (
        <>
          <p className="text-3xl font-semibold tracking-tight text-slate-900">
            {st.completionRate}% <span className="text-base font-medium text-slate-600">completion rate</span>
          </p>
          <ProgressBar className="mt-3" value={st.completionRate ?? 0} label="Completion rate" />
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Completed", st.completedSessions],
              ["Skipped", st.skippedSessions],
              ["Missed", st.missedSessions],
              ["Still to come", st.upcomingSessions],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-xs text-slate-600">{label}</dt>
                <dd className="text-lg font-semibold text-slate-900">{n}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-600">
            Completion rate = completed ÷ (completed + skipped + missed){data.range === "all" ? "" : ` in the last ${RANGE_LABEL[data.range].toLowerCase()}`}. Rescheduled sessions are counted where they were moved to.
          </p>
        </>
      ) : (
        <SectionEmpty title="Nothing to measure yet">Once sessions in your study plan have been completed, skipped or missed, your completion rate appears here.</SectionEmpty>
      )}
    </Section>
  );
}

export function ActivitySection({ data }: { data: ProgressResponse }) {
  const items = data.studyTime.byActivity;
  return (
    <Section title="How you study" className="h-full">
      {items.length > 0 ? (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.activityType}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-medium text-slate-900">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: ACTIVITY_COLOR[a.activityType] }} />
                  {ACTIVITY_LABEL[a.activityType]}
                </span>
                <span className="tabular-nums text-slate-700">
                  {Math.round(a.percentage)}% <span className="text-slate-500">· {formatMinutes(a.minutes)}</span>
                </span>
              </div>
              <ProgressBar className="mt-1.5" value={a.percentage} label={`${ACTIVITY_LABEL[a.activityType]} share of study time`} color={ACTIVITY_COLOR[a.activityType]} />
            </li>
          ))}
        </ul>
      ) : (
        <SectionEmpty title="No activity yet">Your mix of learning, practice, quizzes and revision shows up after you complete sessions.</SectionEmpty>
      )}
      {data.studyTime.bySubject.length > 0 && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Time by subject</h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {data.studyTime.bySubject.map((s) => (
              <li key={s.subject} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-slate-800">{s.subject}</span>
                <span className="shrink-0 tabular-nums text-slate-600">
                  {formatMinutes(s.minutes)} · {s.sessions} {s.sessions === 1 ? "session" : "sessions"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
