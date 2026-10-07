import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressRange, ProgressResponse } from "@copilot/shared";
import { getProgress } from "../../lib/progressApi";

export type ProgressState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: ProgressResponse; error: null; /** true while a newly chosen range is loading (the old numbers stay on screen). */ refreshing: boolean }
  | { status: "error"; data: ProgressResponse | null; error: string };

/**
 * Loads Progress for a range. One request per range choice (no polling, no timers). Changing the range keeps the
 * previous numbers visible while the new ones load, so the page does not flash back to a skeleton.
 */
export function useProgress(client: SupabaseClient, range: ProgressRange) {
  const [state, setState] = useState<ProgressState>({ status: "loading", data: null, error: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => (s.data ? { status: "ready", data: s.data, error: null, refreshing: true } : { status: "loading", data: null, error: null }));
    try {
      const data = await getProgress(client, range);
      if (seq.current === mine) setState({ status: "ready", data, error: null, refreshing: false });
    } catch (e) {
      if (seq.current === mine) setState((s) => ({ status: "error", data: s.data, error: e instanceof Error ? e.message : "Something went wrong." }));
    }
  }, [client, range]);

  useEffect(() => {
    void load();
    return () => void seq.current++;
  }, [load]);

  return { state, retry: load };
}
