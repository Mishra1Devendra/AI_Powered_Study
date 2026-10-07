import { Navigate, Outlet, useLocation } from "react-router";
import { FullPageSpinner } from "../components/ui/Spinner";
import { useAuth } from "./AuthProvider";

/** Only same-app absolute paths are honoured as a post-login destination. */
function safeDestination(from: unknown): string {
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/login") && !from.startsWith("/signup")
    ? from
    : "/dashboard";
}

/** Renders child routes only for signed-in users; everyone else is sent to /login. */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullPageSpinner label="Checking your session" />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/** Login/signup are for signed-out users; signed-in users go to where they were headed. */
export function PublicOnlyRoute() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullPageSpinner label="Checking your session" />;
  if (status === "authenticated") {
    return <Navigate to={safeDestination((location.state as { from?: unknown } | null)?.from)} replace />;
  }
  return <Outlet />;
}
