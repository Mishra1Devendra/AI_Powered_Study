import { useEffect, useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ErrorState } from "../components/ui/ErrorState";
import { setResume } from "../features/continue/resumeStore";
import { DashboardSkeleton } from "../features/dashboard/DashboardSkeleton";
import { DashboardView } from "../features/dashboard/DashboardView";
import { useDashboard } from "../features/dashboard/useDashboard";
import { RecommendedForYouView, type RecoLoad } from "../features/recommendations/RecommendedForYou";
import { useRecommendations } from "../features/recommendations/useRecommendations";
import { friendlyMessage } from "../lib/errors";

/** The student's home screen: loads their real dashboard data and renders it. */
export default function DashboardPage() {
  const { client, user } = useAuth();
  const { state, reload } = useDashboard();
  // ONE recommendations request, shared by the "Recommended for You" card and the "continue learning" hero's fallback.
  const reco = useRecommendations(client, 3);
  const now = useMemo(() => new Date(), []);

  // Let the sidebar / module screens offer the same "continue" shortcut without asking the server again.
  useEffect(() => {
    if (state.status === "ready" && user) setResume(user.id, state.dashboard.resume ?? null);
  }, [state, user]);

  if (state.status === "loading") return <DashboardSkeleton />;
  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-md pt-6">
        <ErrorState message={friendlyMessage(null)} onRetry={() => void reload()} />
      </div>
    );
  }
  const recoState: RecoLoad = reco.state.status === "error" ? { status: "error", message: friendlyMessage(null) } : (reco.state as RecoLoad);
  const top = reco.state.status === "ready" ? (reco.state.data.recommendations[0] ?? null) : null;
  return (
    <DashboardView
      dashboard={state.dashboard}
      now={now}
      topRecommendation={top}
      recommendations={<RecommendedForYouView state={recoState} onRetry={() => void reco.reload()} />}
    />
  );
}
