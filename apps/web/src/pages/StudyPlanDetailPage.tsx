import { Link, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { PlanView } from "../features/planner/PlanView";
import { usePlannerPaths } from "../features/planner/paths";
import { usePlanDetail } from "../features/planner/usePlannerData";
import { LoadingState } from "../components/ui/LoadingState";

/** `/study-plan/:planId`: one plan - being created, failed, active or a previous one. */
export default function StudyPlanDetailPage() {
  const p = usePlannerPaths();
  const { planId = "" } = useParams<{ planId: string }>();
  const { client } = useAuth();
  const detail = usePlanDetail(client, planId);

  return (
    <div className="animate-fade-up space-y-4">
      <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> Study plan
      </Link>
      {detail.state.status === "loading" && (
        <LoadingState label="Loading…" />
      )}
      {detail.state.status === "error" && (
        <div className="mx-auto max-w-xl space-y-3">
          <Alert tone="error">{detail.notFound ? "This study plan doesn't exist, or it isn't yours." : detail.state.message}</Alert>
          {!detail.notFound && (
            <Button variant="secondary" onClick={() => void detail.reload()}>
              Try again
            </Button>
          )}
        </div>
      )}
      {detail.state.status === "ready" && detail.state.data && <PlanView data={detail.state.data} refresh={detail.refresh} />}
    </div>
  );
}
