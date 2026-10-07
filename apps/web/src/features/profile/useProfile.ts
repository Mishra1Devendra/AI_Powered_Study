import { useCallback, useEffect, useState } from "react";
import type { MeResponse, Profile } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { fetchMe } from "../../lib/api";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; me: MeResponse };

/** Loads the signed-in student's profile from the API (RLS-protected on the server). */
export function useProfile() {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", me: await fetchMe(client) });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load your profile." });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const setProfile = useCallback((profile: Profile) => {
    setState((s) => (s.status === "ready" ? { status: "ready", me: { ...s.me, profile } } : s));
  }, []);

  return { state, reload: load, setProfile };
}
