import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { PROGRESS_THRESHOLDS, type ProgressResponse, type SubjectStat, type TopicStat } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { LevelBadge, Meter } from "./Badges";
import { formatMinutes, pctText } from "./format";
import { useProgressPaths } from "./paths";

const MIN = PROGRESS_THRESHOLDS.minQuestionsForMastery;
const questionsText = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`;

function SubjectCard({ s }: { s: SubjectStat }) {
  return (
    <li className="rounded-2xl bg-slate-50/70 p-4 ring-1 ring-slate-200/70">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold text-slate-900">{s.subject}</h3>
        <LevelBadge level={s.level} />
      </div>
      {s.accuracy !== null ? (
        <div className="mt-3">
          <p className="text-2xl font-semibold tracking-tight text-slate-900">
            {pctText(s.accuracy)} <span className="text-xs font-medium text-slate-600">quiz accuracy</span>
          </p>
          <div className="mt-1.5">
            <Meter value={s.accuracy} level={s.level} label={`${s.subject} quiz accuracy`} />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-600">{s.questions > 0 ? `No performance data yet (${questionsText(s.questions)} so far, ${MIN} needed)` : "No performance data yet"}</p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-slate-600">Study time</dt>
          <dd className="text-sm font-semibold text-slate-900">{formatMinutes(s.studyMinutes)}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Sessions</dt>
          <dd className="text-sm font-semibold text-slate-900">{s.completedSessions}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Quizzes</dt>
          <dd className="text-sm font-semibold text-slate-900">{s.quizzes}</dd>
        </div>
      </dl>
      {s.topics.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-slate-200 pt-2 text-xs">
          {s.topics.slice(0, 3).map((t) => (
            <li key={t.topic} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-slate-700">{t.topic}</span>
              <span className="shrink-0 tabular-nums text-slate-800">{t.accuracy === null ? "—" : pctText(t.accuracy)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function SubjectSection({ subjects }: { subjects: SubjectStat[] }) {
  return (
    <Section title="Subjects">
      {subjects.length > 0 ? (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {subjects.map((s) => (
            <SubjectCard key={s.subject} s={s} />
          ))}
        </ul>
      ) : (
        <SectionEmpty title="No subject data yet">Subjects appear after you complete study sessions or finish quizzes that have a subject.</SectionEmpty>
      )}
    </Section>
  );
}

function TopicRow({ t }: { t: TopicStat }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-slate-900">{t.topic}</p>
          {t.subject && <p className="text-xs text-slate-600">{t.subject}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-slate-900">{t.accuracy === null ? "—" : pctText(t.accuracy)}</span>
          <LevelBadge level={t.level} />
        </div>
      </div>
      {t.accuracy !== null ? (
        <div className="mt-2">
          <Meter value={t.accuracy} level={t.level} label={`${t.topic} accuracy`} />
        </div>
      ) : null}
      <p className="mt-1 text-xs text-slate-600">
        {t.accuracy === null ? `${questionsText(t.total)} answered so far - ${MIN} are needed before showing a percentage` : `${t.correct} of ${questionsText(t.total)} correct`}
      </p>
    </li>
  );
}

export function TopicSection({ topics }: { topics: TopicStat[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? topics : topics.slice(0, 6);
  return (
    <Section title="Topic mastery" className="h-full">
      {topics.length > 0 ? (
        <>
          <ul className="divide-y divide-slate-100">
            {shown.map((t) => (
              <TopicRow key={t.topic} t={t} />
            ))}
          </ul>
          {topics.length > 6 && (
            <Button variant="ghost" className="mt-2 h-10" onClick={() => setAll(!all)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${topics.length} topics`}
            </Button>
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            Topic accuracy = correct answers ÷ questions. A label needs at least {MIN} questions. Strong is {PROGRESS_THRESHOLDS.strongAtOrAbove}% or more, Weak is under {PROGRESS_THRESHOLDS.weakBelow}%. These are simple guides
            based on your own quiz answers, not a test of ability.
          </p>
        </>
      ) : (
        <SectionEmpty title="No topic data yet">Take a quiz and your results are grouped by topic here.</SectionEmpty>
      )}
    </Section>
  );
}

export function WeakAreasSection({ data }: { data: ProgressResponse }) {
  const p = useProgressPaths();
  const navigate = useNavigate();
  const { weakAreas, topicSummary } = data;
  return (
    <Section title="Needs attention" className="h-full">
      {weakAreas.length > 0 ? (
        <ul className="space-y-3">
          {weakAreas.map((t) => (
            <li key={t.topic} className="rounded-xl bg-red-50/40 p-3 ring-1 ring-red-100">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-semibold text-slate-900">{t.topic}</p>
                <LevelBadge level="weak" />
              </div>
              <p className="mt-1 text-sm text-slate-700">
                {pctText(t.accuracy)} accuracy · {questionsText(t.total)} answered
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <LinkButton to={p.practice(t.subject, t.topic)} size="sm" aria-label={`Practice topic: ${t.topic}`}>
                  Practice Topic
                </LinkButton>
                <Button
                  variant="secondary"
                  className="h-9 px-3.5"
                  aria-label={`Ask AI Tutor about ${t.topic}`}
                  onClick={() =>
                    navigate(p.tutor, {
                      state: { draft: `Explain ${t.topic}${t.subject ? ` (${t.subject})` : ""} step by step, and test me on the parts people usually find hard.`, ...(t.subject ? { subject: t.subject } : {}), topic: t.topic },
                    })
                  }
                >
                  Ask AI Tutor
                </Button>
              </div>
            </li>
          ))}
          <li className="text-xs text-slate-600">Both buttons only open the page with the topic filled in. Nothing is generated until you press the button there.</li>
        </ul>
      ) : topicSummary.withEnoughData === 0 ? (
        <SectionEmpty title="Not enough data yet">Complete a few more quizzes ({MIN}+ questions on a topic) to see where you need practice.</SectionEmpty>
      ) : (
        <SectionEmpty title="No weak topics">Every topic with enough data is at {PROGRESS_THRESHOLDS.weakBelow}% or better. Keep going.</SectionEmpty>
      )}
    </Section>
  );
}

export function ImprovingSection({ data }: { data: ProgressResponse }) {
  const { improving, improvementComparable } = data;
  return (
    <Section title="Improving" className="h-full">
      {improving.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {improving.map((t) => (
            <li key={t.topic} className="py-3">
              <p className="break-words text-sm font-semibold text-slate-900">{t.topic}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-700">
                <span>Previous: {pctText(t.trend!.previous)}</span>
                <span aria-hidden="true">→</span>
                <span className="font-semibold text-emerald-800">Recent: {pctText(t.trend!.recent)}</span>
                <span className="text-xs text-slate-600">(+{t.trend!.delta} points)</span>
              </p>
            </li>
          ))}
        </ul>
      ) : improvementComparable ? (
        <SectionEmpty title="No clear improvement yet">No topic has gained {PROGRESS_THRESHOLDS.improvingDelta} points or more between your earlier and recent quizzes.</SectionEmpty>
      ) : (
        <SectionEmpty title="Not enough history">Complete more quizzes to see improvement trends.</SectionEmpty>
      )}
    </Section>
  );
}

export function StartLinks() {
  const p = useProgressPaths();
  return (
    <div className="flex flex-wrap justify-center gap-3">
      <LinkButton to={p.studyPlan}>Open study plan</LinkButton>
      <LinkButton to={p.quizHome} variant="secondary">
        Take a quiz
      </LinkButton>
      <Link to={p.tutor} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-brand-700 hover:bg-brand-50">
        Ask AI Tutor
      </Link>
    </div>
  );
}
