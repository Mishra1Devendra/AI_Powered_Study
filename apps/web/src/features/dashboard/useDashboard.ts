import { useCallback, useEffect, useState } from "react";
import type { Dashboard } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { fetchDashboard } from "../../lib/api";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; dashboard: Dashboard };

/** Loads the signed-in student's dashboard from the API (identity comes from the token). */
export function useDashboard() {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", dashboard: await fetchDashboard(client) });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load your dashboard." });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, reload: load };
}
