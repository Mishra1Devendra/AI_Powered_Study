import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttemptHistoryItem, Quiz, QuizDetailResponse, QuizOptions, QuizSummary } from "@copilot/shared";
import { ApiError } from "../../lib/api";
import { getQuiz, getQuizOptions, listAttempts, listQuizzes } from "../../lib/quizApi";

/** The quiz page polls one cheap query; the home list (quizzes + summary) is heavier, so it polls less often. */
const DETAIL_POLL_MS = 3000;
const HOME_POLL_MS = 6000;
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** A request that re-runs when `deps` change, ignores stale answers, and can poll while `shouldPoll` says so. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[], shouldPoll: (data: T) => boolean = () => false, pollMs = DETAIL_POLL_MS) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) setState({ status: "loading" });
    try {
      const data = await fetchRef.current();
      if (seq.current === mine) setState({ status: "ready", data });
    } catch (e) {
      if (seq.current !== mine) return;
      // A failed background refresh keeps what is already on screen.
      setState((s) => (quiet && s.status === "ready" ? s : { status: "error", message: message(e, "Something went wrong. Please try again.") }));
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load(false);
    return () => void seq.current++;
  }, deps);

  const polling = state.status === "ready" && shouldPoll(state.data);
  useEffect(() => {
    if (!polling) return;
    // A hidden tab does not need fresh data: skip the request (and ask again at the next tick).
    const t = setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) void Promise.resolve().then(() => setState((s) => ({ ...s })));
      else void load(true);
    }, pollMs);
    return () => clearTimeout(t);
  }, [polling, state, load, pollMs]);

  return { state, reload: () => load(false), refresh: () => load(true) };
}

export interface QuizHomeData {
  quizzes: Quiz[];
  summary: QuizSummary;
}

/** The quiz home: your quizzes + real summary. Refreshes by itself while a quiz is still being created. */
export function useQuizHome(client: SupabaseClient) {
  return useLoad<QuizHomeData>(() => listQuizzes(client), [client], (d) => d.quizzes.some((q) => q.status === "generating"), HOME_POLL_MS);
}

export function useAttemptHistory(client: SupabaseClient) {
  return useLoad<AttemptHistoryItem[]>(() => listAttempts(client), [client]);
}

export function useQuizOptions(client: SupabaseClient) {
  return useLoad<QuizOptions>(() => getQuizOptions(client), [client]);
}

/** One quiz. Polls while it is being created so the page flips to "ready" on its own. */
export function useQuizDetail(client: SupabaseClient, quizId: string) {
  const result = useLoad<QuizDetailResponse>(() => getQuiz(client, quizId), [client, quizId], (d) => d.quiz.status === "generating");
  const notFound = result.state.status === "error" && /not found/i.test(result.state.message);
  return { ...result, notFound };
}

export { ApiError };
