import type { ReactNode } from "react";
import type { Dashboard, Recommendation } from "@copilot/shared";
import { DashboardHeader, contextMessage } from "./DashboardHeader";
import { FocusCard } from "./FocusCard";
import { ProgressSnapshot } from "./ProgressSnapshot";
import { VivaCard } from "./VivaCard";
import { QuickActions } from "./QuickActions";
import { RecentActivity } from "./RecentActivity";
import { SubjectProgress } from "./SubjectProgress";
import { TodayProgress } from "./TodayProgress";
import { TodaysPlan } from "./TodaysPlan";
import { WeakTopics } from "./WeakTopics";

/** Staggered, restrained entrance (disabled automatically for reduced-motion users). */
function Reveal({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="animate-fade-up" style={{ animationDelay: `${index * 60}ms` }}>
      {children}
    </div>
  );
}

/**
 * The student's home: "what should I do right now?" first, then today, then why (recommendations), then the picture of how
 * they are doing. Pure presentation - it renders whatever dashboard data it is given (real or test fixture).
 *
 *   Welcome -> Continue learning -> Today's focus + Recommended for you -> Progress + Subjects -> Activity -> Quick actions
 */
export function DashboardView({
  dashboard,
  now,
  recommendations,
  topRecommendation = null,
}: {
  dashboard: Dashboard;
  now: Date;
  /** The self-loading Recommended for You card (omitted in fixtures and previews). */
  recommendations?: ReactNode;
  /** The student's top recommendation, offered as the next step only when nothing else is in progress. */
  topRecommendation?: Recommendation | null;
}) {
  return (
    <div className="space-y-6">
      <Reveal index={0}>
        <DashboardHeader displayName={dashboard.profile.displayName} now={now} summary={contextMessage(dashboard)} streakDays={dashboard.today.streakDays} />
      </Reveal>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Reveal index={1}>
            <FocusCard dashboard={dashboard} recommendation={topRecommendation} />
          </Reveal>
        </div>
        <div className="min-w-0">
          <Reveal index={2}>
            <TodayProgress today={dashboard.today} />
          </Reveal>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-6 lg:col-span-3">
          <Reveal index={3}>
            <TodaysPlan plan={dashboard.plan} />
          </Reveal>
          <Reveal index={4}>
            <RecentActivity items={dashboard.activity} now={now} />
          </Reveal>
        </div>
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {recommendations && <Reveal index={3}>{recommendations}</Reveal>}
          <Reveal index={4}>
            <ProgressSnapshot progress={dashboard.progress} />
          </Reveal>
          <Reveal index={5}>
            <SubjectProgress subjects={dashboard.subjects} overview={dashboard.progress?.subjectOverview} />
          </Reveal>
          <Reveal index={6}>
            <WeakTopics topics={dashboard.weakTopics} />
          </Reveal>
          <Reveal index={6}>
            <VivaCard viva={dashboard.progress?.viva} />
          </Reveal>
        </div>
      </div>
      <Reveal index={7}>
        <QuickActions />
      </Reveal>
    </div>
  );
}
