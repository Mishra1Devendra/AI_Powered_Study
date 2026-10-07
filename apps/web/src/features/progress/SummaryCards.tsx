import type { ReactNode } from "react";
import { RANGE_LABEL, type ProgressResponse } from "@copilot/shared";
import { FlameIcon, QuizIcon, TargetIcon, ClockIcon } from "../../components/ui/Icons";
import { formatMinutes, pctText } from "./format";

function Card({ title, icon, tone, children }: { title: string; icon: ReactNode; tone: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}>
          {icon}
        </span>
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      {children}
    </section>
  );
}

const Big = ({ children }: { children: ReactNode }) => <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{children}</p>;
const Hint = ({ children }: { children: ReactNode }) => <p className="mt-1 text-sm text-slate-600">{children}</p>;
const NotEnough = () => <p className="mt-3 text-lg font-semibold text-slate-600">Not enough data yet</p>;

function Change({ now, before, label }: { now: number; before: number | null; label: string }) {
  if (before === null) return <Hint>No earlier study time to compare with.</Hint>;
  const diff = now - before;
  const pct = Math.round((Math.abs(diff) / before) * 100);
  return (
    <Hint>
      <span className="font-medium text-slate-800">{diff === 0 ? "Same as" : `${diff > 0 ? "Up" : "Down"} ${pct}% from`}</span> the {label} before ({formatMinutes(before)})
    </Hint>
  );
}

/** The four headline numbers. Anything without data says so instead of showing a made-up value. */
export function SummaryCards({ data }: { data: ProgressResponse }) {
  const { studyTime: st, quiz: q, topicSummary: t, streak, range } = data;
  const rangeText = RANGE_LABEL[range].toLowerCase();
  const compare = range === "all" ? null : rangeText;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card title="Study time" icon={<ClockIcon className="h-5 w-5" />} tone="bg-brand-50 text-brand-600">
        {st.completedSessions > 0 ? (
          <>
            <Big>{formatMinutes(st.totalMinutes)}</Big>
            <Hint>
              {st.completedSessions} {st.completedSessions === 1 ? "session" : "sessions"} completed · {range === "all" ? "all time" : `last ${rangeText}`}
            </Hint>
            {compare && <Change now={st.totalMinutes} before={st.previousMinutes} label={compare} />}
          </>
        ) : (
          <>
            <Big>0m</Big>
            <Hint>No completed study sessions {range === "all" ? "yet" : `in the last ${rangeText}`}.</Hint>
          </>
        )}
      </Card>

      <Card title="Quiz performance" icon={<QuizIcon className="h-5 w-5" />} tone="bg-amber-50 text-amber-700">
        {q.attemptsCompleted > 0 ? (
          <>
            <Big>{pctText(q.averageScore)}</Big>
            <Hint>average score · {q.attemptsCompleted === 1 ? "1 quiz attempt" : `${q.attemptsCompleted} quiz attempts`}</Hint>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              {[
                ["Highest", q.highestScore],
                ["Lowest", q.lowestScore],
                ["Latest", q.recentScore],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="text-sm font-semibold text-slate-900">{pctText(v as number | null)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <>
            <Big>—</Big>
            <Hint>No finished quizzes {range === "all" ? "yet" : `in the last ${rangeText}`}.</Hint>
          </>
        )}
      </Card>

      <Card title="Topics" icon={<TargetIcon className="h-5 w-5" />} tone="bg-teal-50 text-teal-700">
        {t.studied > 0 ? (
          <>
            <Big>{t.studied}</Big>
            <Hint>
              {t.studied === 1 ? "topic" : "topics"} studied · {t.withEnoughData} with enough quiz data
            </Hint>
            {t.withEnoughData > 0 ? (
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="font-medium text-emerald-800">{t.strong} strong</span>
                <span className="font-medium text-amber-900">{t.needsPractice} need practice</span>
                <span className="font-medium text-red-800">{t.weak} weak</span>
              </p>
            ) : (
              <p className="mt-3 text-sm text-slate-600">Answer at least 5 questions on a topic to see how you are doing.</p>
            )}
          </>
        ) : (
          <>
            <Big>—</Big>
            <Hint>No topics studied {range === "all" ? "yet" : `in the last ${rangeText}`}.</Hint>
          </>
        )}
      </Card>

      <Card title="Study streak" icon={<FlameIcon className="h-5 w-5" />} tone="bg-orange-50 text-orange-700">
        {streak.current === null ? (
          <NotEnough />
        ) : (
          <>
            <Big>
              {streak.current} {streak.current === 1 ? "day" : "days"}
            </Big>
            <Hint>{streak.current === 0 ? "Complete a session today to start a new streak." : "in a row, ending " + (streak.lastStudyDate === data.today ? "today" : "yesterday")}</Hint>
            <Hint>
              Longest: {streak.longest} {streak.longest === 1 ? "day" : "days"} · {streak.studyDays} study {streak.studyDays === 1 ? "day" : "days"} in total
            </Hint>
          </>
        )}
      </Card>
    </div>
  );
}
