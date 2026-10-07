import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttemptView, QuizResult } from "@copilot/shared";
import { ApiError } from "../../lib/api";
import { getAttempt, getResult, saveAnswers, submitAttempt } from "../../lib/quizApi";

type Load = { status: "loading" } | { status: "error"; message: string; notFound: boolean } | { status: "ready"; view: AttemptView };

export type SaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 400;

/**
 * Running one attempt. The student's choices live here (so moving between questions never loses
 * them) and are saved to the server in the background, so even a refresh keeps them. The score is
 * never calculated here: submitting sends the choices and the server answers with the result.
 */
export function useAttempt(client: SupabaseClient, attemptId: string) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [index, setIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const answersRef = useRef(answers);
  answersRef.current = answers;
  const pending = useRef(new Map<string, number | null>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submittingRef = useRef(false);
  const seq = useRef(0);
  /** server clock minus browser clock, so the countdown follows the server's notion of "now". */
  const skew = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoad({ status: "loading" });
    try {
      const view = await getAttempt(client, attemptId);
      if (seq.current !== mine) return;
      skew.current = new Date(view.serverNow).getTime() - Date.now();
      setAnswers(view.answers);
      setIndex(0);
      setLoad({ status: "ready", view });
    } catch (e) {
      if (seq.current !== mine) return;
      const notFound = e instanceof ApiError && e.status === 404;
      setLoad({ status: "error", notFound, message: notFound ? "This quiz attempt doesn't exist." : e instanceof Error ? e.message : "Could not load this quiz." });
    }
  }, [client, attemptId]);

  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
      clearTimeout(timer.current);
    };
  }, [reload]);

  /** Sends the choices made since the last save. Failed ones stay queued for the next try. */
  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    if (pending.current.size === 0) return true;
    const batch = new Map(pending.current);
    pending.current.clear();
    setSaveState("saving");
    try {
      await saveAnswers(client, attemptId, { answers: [...batch].map(([questionId, selected]) => ({ questionId, selected })) });
      setSaveState(pending.current.size > 0 ? "saving" : "saved");
      return true;
    } catch {
      for (const [q, v] of batch) if (!pending.current.has(q)) pending.current.set(q, v); // keep newer choices, requeue the rest
      setSaveState("error");
      return false;
    }
  }, [client, attemptId]);

  const choose = useCallback(
    (questionId: string, selected: number | null) => {
      setAnswers((prev) => {
        const next = { ...prev };
        if (selected === null) delete next[questionId];
        else next[questionId] = selected;
        return next;
      });
      pending.current.set(questionId, selected);
      setSaveState("saving");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  const submit = useCallback(async () => {
    if (submittingRef.current || result) return; // never twice
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    clearTimeout(timer.current);
    pending.current.clear();
    try {
      // The final, complete set of choices travels with the submit, so a failed autosave cannot lose any.
      const final = Object.entries(answersRef.current).map(([questionId, selected]) => ({ questionId, selected }));
      setResult(await submitAttempt(client, attemptId, { answers: final }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        setSubmitError(e.message);
      } else if (e instanceof ApiError && (e.status === 409 || e.status === 410)) {
        // Already submitted or timed out: the stored result is the truth.
        try {
          setResult(await getResult(client, attemptId));
        } catch (inner) {
          setSubmitError(inner instanceof Error ? inner.message : "Could not load your result.");
        }
      } else {
        setSubmitError(e instanceof Error ? e.message : "Could not submit. Please try again.");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [client, attemptId, result]);

  // Countdown for timed quizzes. Only a display: the server enforces the deadline.
  const expiresAt = load.status === "ready" && load.view.attempt.status === "in_progress" ? load.view.attempt.expiresAt : null;
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      const left = (new Date(expiresAt).getTime() - (Date.now() + skew.current)) / 1000;
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        if (!autoSubmitted.current) {
          autoSubmitted.current = true;
          void submit();
        }
        return;
      }
      t = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [expiresAt, submit]);

  const questions = load.status === "ready" ? load.view.questions : [];
  return {
    load,
    reload,
    questions,
    answers,
    answeredCount: Object.keys(answers).length,
    index,
    goTo: (i: number) => setIndex(Math.min(Math.max(0, i), Math.max(0, questions.length - 1))),
    choose,
    saveState,
    retrySave: flush,
    flush,
    submit,
    submitting,
    submitError,
    result,
    remaining,
  };
}
