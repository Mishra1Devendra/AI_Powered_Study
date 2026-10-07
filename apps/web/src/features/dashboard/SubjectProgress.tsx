import { SCORE_LEVEL_LABEL_FOR_MASTERY } from "./masteryLabels";
import type { ProgressSnapshot, SubjectProgress as SubjectProgressData } from "@copilot/shared";
import { LinkButton } from "../../components/ui/LinkButton";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { formatMinutes, subjectColor } from "./format";

type Overview = NonNullable<ProgressSnapshot["subjectOverview"]>;

/**
 * The student's subjects, from the SAME numbers as the Progress page: quiz accuracy per subject (only once there are enough
 * questions to judge) and study time from completed sessions. Fixture-style "topics completed" subjects are still shown if given.
 */
export function SubjectProgress({ subjects, overview = [] }: { subjects: SubjectProgressData[]; overview?: Overview | undefined }) {
  const hasOverview = overview.length > 0;
  return (
    <Section title="Subject overview" action={hasOverview ? <LinkButton to="/progress" variant="ghost" size="sm">Details</LinkButton> : undefined}>
      {hasOverview ? (
        <ul className="space-y-5">
          {overview.map((s) => (
            <li key={s.subject}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-semibold text-slate-900">{s.subject}</span>
                <span className="shrink-0 text-sm tabular-nums text-slate-700">{s.accuracy !== null ? `${Math.round(s.accuracy)}%` : "Not enough quiz data"}</span>
              </div>
              {s.accuracy !== null && <ProgressBar value={s.accuracy} label={`${s.subject} quiz accuracy`} color={subjectColor(s.subject)} />}
              <p className="mt-1.5 text-xs text-slate-600">
                {[s.accuracy !== null ? SCORE_LEVEL_LABEL_FOR_MASTERY[s.level] : null, s.questions > 0 ? `${s.questions} quiz questions` : null, s.studyMinutes > 0 ? `${formatMinutes(s.studyMinutes)} studied` : null].filter(Boolean).join(" · ") || "Complete a quiz or study session to see more."}
              </p>
            </li>
          ))}
        </ul>
      ) : subjects.length > 0 ? (
        <ul className="space-y-5">
          {subjects.map((s) => (
            <li key={s.id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-semibold text-slate-900">{s.name}</span>
                <span className="shrink-0 text-sm tabular-nums text-slate-600">{Math.round(s.progressPercent)}%</span>
              </div>
              <ProgressBar value={s.progressPercent} label={`${s.name} progress`} color={subjectColor(s.name)} />
              <p className="mt-1.5 text-xs text-slate-600">
                {s.topicsCompleted} of {s.topicsTotal} topics completed
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <SectionEmpty
          title="No subjects yet"
          action={
            <LinkButton to="/quiz" variant="secondary" size="sm">
              Take a quiz
            </LinkButton>
          }
        >
          Your subjects appear here once you finish a quiz or complete a study session, with how you are doing in each.
        </SectionEmpty>
      )}
    </Section>
  );
}
