import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { DashboardSkeleton } from "../features/dashboard/DashboardSkeleton";
import { DashboardView } from "../features/dashboard/DashboardView";
import { emptyDashboard, sampleDashboard } from "../features/dashboard/sample";

/**
 * DEV-ONLY design preview at /dev/dashboard?state=sample|empty|loading.
 * Uses fixture data, makes no API calls, touches no database, and is removed from production builds.
 */
export default function DevDashboardPreview() {
  const [params] = useSearchParams();
  const state = params.get("state") ?? "sample";
  const now = useMemo(() => new Date(), []);

  return (
    <div className="space-y-6">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> This is a development build fixture, not any student&apos;s progress. States:{" "}
        <a className="underline" href="?state=sample">sample</a> · <a className="underline" href="?state=empty">empty</a> ·{" "}
        <a className="underline" href="?state=loading">loading</a>
      </div>
      {state === "loading" ? (
        <DashboardSkeleton />
      ) : (
        <DashboardView dashboard={state === "empty" ? emptyDashboard() : sampleDashboard(now)} now={now} />
      )}
    </div>
  );
}
