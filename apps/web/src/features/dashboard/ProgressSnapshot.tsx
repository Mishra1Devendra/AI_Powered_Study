import type { ProgressSnapshot as Snapshot } from "@copilot/shared";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section } from "../../components/ui/Section";
import { formatMinutes } from "./format";

const NO_DATA = (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only">No data yet</span>
  </>
);

/** A compact view of the Progress page (last 30 days). Real numbers only; a missing one shows "—", never a made-up value. */
export function ProgressSnapshot({ progress }: { progress: Snapshot | null }) {
  const hasStudy = progress !== null && progress.studyMinutes > 0;
  const streak = progress?.currentStreak;
  return (
    <Section title="Your progress">
      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-slate-600">Average score</dt>
          <dd className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{progress?.averageScore != null ? `${Math.round(progress.averageScore)}%` : NO_DATA}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">Study time</dt>
          <dd className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{hasStudy ? formatMinutes(progress.studyMinutes) : NO_DATA}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-600">Current streak</dt>
          <dd className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{streak == null ? NO_DATA : `${streak} ${streak === 1 ? "day" : "days"}`}</dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-slate-500">Last 30 days</p>
      <div className="mt-4 rounded-xl bg-slate-50 px-3.5 py-3 text-sm">
        {progress?.weakTopic ? (
          <>
            <span className="text-xs font-medium text-slate-600">Weak topic</span>
            <span className="mt-0.5 block font-semibold text-slate-900">
              {progress.weakTopic.topic} — {Math.round(progress.weakTopic.accuracy)}%
            </span>
          </>
        ) : (
          <span className="text-slate-600">{progress && progress.attemptsCompleted > 0 ? "No weak topics found." : "Finish a few quizzes to see which topics need work."}</span>
        )}
      </div>
      <div className="mt-4">
        <LinkButton to="/progress" variant="secondary" size="sm">
          View full progress
        </LinkButton>
      </div>
    </Section>
  );
}
