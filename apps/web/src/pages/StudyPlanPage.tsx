import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState } from "../components/ui/EmptyState";
import { PlanIcon } from "../components/ui/Icons";
import { LinkButton } from "../components/ui/LinkButton";
import { PlanView } from "../features/planner/PlanView";
import { PreviousPlans } from "../features/planner/PreviousPlans";
import { usePlannerPaths } from "../features/planner/paths";
import { usePlanDetail, usePlanList } from "../features/planner/usePlannerData";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";

function Loading() {
  return (
    <LoadingState label="Loading your study plan…" />
  );
}

/** `/study-plan`: your active plan (or the one being created), and earlier plans. */
export default function StudyPlanPage() {
  const p = usePlannerPaths();
  const { client } = useAuth();
  const list = usePlanList(client);
  const data = list.state.status === "ready" ? list.state.data : null;
  const generating = data?.plans.find((x) => x.status === "generating") ?? null;
  const shownId = data ? (data.activePlanId ?? generating?.id ?? null) : null;
  const detail = usePlanDetail(client, shownId);

  if (list.state.status === "loading") return <Loading />;
  if (list.state.status === "error") {
    return (
      <div className="mx-auto max-w-xl py-10"><ErrorState message={list.state.message} onRetry={() => void list.reload()} /></div>
    );
  }

  const previous = data!.plans.filter((x) => x.id !== shownId && x.status !== "generating");
  const refresh = async () => {
    await Promise.all([detail.refresh(), list.refresh()]);
  };

  return (
    <div className="animate-fade-up space-y-6">
      {!shownId ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Study plan</h1>
          </div>
          <div className="rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70">
            <EmptyState title="No study plan yet" icon={<PlanIcon className="h-6 w-6" />}>
              Tell us your exam date, subjects and how much time you have. Your local AI picks the topics and the app builds a day-by-day schedule that fits.
            </EmptyState>
            <div className="flex justify-center pb-10">
              <LinkButton to={p.create}>Create study plan</LinkButton>
            </div>
          </div>
        </>
      ) : (
        <>
          {generating && data!.activePlanId && (
            <p className="rounded-xl bg-brand-50 px-4 py-2.5 text-sm text-brand-900">
              A new plan is being created.{" "}
              <Link to={p.plan(generating.id)} className="font-semibold underline">
                See its progress
              </Link>
              . This plan stays active until the new one is ready.
            </p>
          )}
          {detail.state.status === "loading" && <Loading />}
          {detail.state.status === "error" && (
            <ErrorState message={detail.state.message} onRetry={() => void detail.reload()} />
          )}
          {detail.state.status === "ready" && detail.state.data && <PlanView data={detail.state.data} refresh={refresh} />}
        </>
      )}
      <PreviousPlans plans={previous} />
      {shownId && (
        <div className="flex justify-center">
          <LinkButton to={p.create} variant="ghost">
            Create a different plan
          </LinkButton>
        </div>
      )}
    </div>
  );
}
