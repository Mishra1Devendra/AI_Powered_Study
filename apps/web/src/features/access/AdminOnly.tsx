import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { Skeleton, SkeletonRegion } from "../../components/ui/Skeleton";
import { useRoleState } from "./AccessGate";

/** Wraps an admin screen: waits until the role is known, then shows it to admins and sends everyone else to the dashboard. The API enforces the same rule. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { role, ready } = useRoleState();
  if (!ready) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <SkeletonRegion label="Checking your access" className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-24 w-full" />
        </SkeletonRegion>
      </div>
    );
  }
  if (role !== "admin") return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
