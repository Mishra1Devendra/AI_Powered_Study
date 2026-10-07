import { useState } from "react";
import type { ProgressRange } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { NothingYet, ProgressError, ProgressSkeleton, RangeFilter, RecentActivitySection } from "../features/progress/Extras";
import { QuizSection } from "../features/progress/QuizSection";
import { ActivitySection, ConsistencySection, StudyTimeSection } from "../features/progress/StudySections";
import { VivaSection } from "../features/progress/VivaSection";
import { SummaryCards } from "../features/progress/SummaryCards";
import { ImprovingSection, SubjectSection, TopicSection, WeakAreasSection } from "../features/progress/TopicSections";
import { useProgress } from "../features/progress/useProgress";

/** `/progress`: how the student is doing, from their own completed sessions and finished quizzes. No AI is involved. */
export default function ProgressPage() {
  const { client } = useAuth();
  const [range, setRange] = useState<ProgressRange>("30d");
  const { state, retry } = useProgress(client, range);
  const data = state.data;
  const refreshing = state.status === "ready" && state.refreshing;
  // Nothing has ever been recorded: no completed or skipped session and no finished quiz.
  const nothingEver = data !== null && data.streak.studyDays === 0 && data.activity.length === 0;

  return (
    <div className="animate-fade-up space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Progress</h1>
          <p className="mt-1 text-sm text-slate-600">How you are doing, worked out from the sessions you complete and the quizzes you finish.</p>
        </div>
        <RangeFilter value={range} onChange={setRange} busy={refreshing} />
      </header>

      {state.status === "loading" && <ProgressSkeleton />}
      {state.status === "error" && !data && <ProgressError message={state.error} onRetry={() => void retry()} />}
      {state.status === "error" && data && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          We couldn&apos;t load your progress for this period. {state.error}{" "}
          <button type="button" onClick={() => void retry()} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {data && nothingEver && state.status !== "error" && <NothingYet />}
      {data && !nothingEver && (
        <div className={`space-y-6 transition-opacity ${refreshing ? "opacity-60" : ""}`} aria-busy={refreshing}>
          <p aria-live="polite" className="sr-only">
            {refreshing ? "Updating numbers" : "Numbers are up to date"}
          </p>
          <SummaryCards data={data} />
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <StudyTimeSection data={data} />
            </div>
            <ActivitySection data={data} />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <QuizSection data={data} />
            </div>
            <ConsistencySection data={data} />
          </div>
          <VivaSection data={data} />
          <SubjectSection subjects={data.subjects} />
          <div className="grid gap-6 lg:grid-cols-2">
            <TopicSection topics={data.topics} />
            <div className="grid gap-6">
              <WeakAreasSection data={data} />
              <ImprovingSection data={data} />
            </div>
          </div>
          <RecentActivitySection data={data} />
        </div>
      )}
    </div>
  );
}
