import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_CHECK_PASS, SESSION_CHECK_QUESTIONS, type SessionCheck, type StudySession } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { friendlyMessage } from "../../lib/errors";
import { getSessionCheck, startSessionCheck, submitSessionCheck } from "../../lib/plannerApi";

/** How often to ask whether the questions are written yet. A plain read: it never starts any AI work. */
export const CHECK_POLL_MS = 3000;
const LETTERS = ["A", "B", "C", "D", "E", "F"];

interface Props {
  session: StudySession;
  /** Called once with the completed session when the check is passed (the session is then done). */
  onPassed: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * "Check your understanding": 5 multiple-choice questions about the session's topic. Passing completes the session; otherwise it
 * stays open and a new set can be requested. Starting a set is always the student's click - nothing here retries on its own.
 */
export function StudyCheck({ session, onPassed, onCancel }: Props) {
  const { client } = useAuth();
  const [check, setCheck] = useState<SessionCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<"start" | "submit" | null>(null);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const begin = useCallback(async () => {
    setBusy("start");
    setError(null);
    setPicked({});
    try {
      const c = await startSessionCheck(client, session.id);
      if (alive.current) setCheck(c);
    } catch (e) {
      if (alive.current) setError(friendlyMessage(e, "The questions could not be started. Please try again."));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [client, session.id]);

  // On open: resume a set that is already in progress (reload, second click), otherwise start one. Once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const existing = await getSessionCheck(client, session.id);
        if (existing && (existing.status === "generating" || existing.status === "ready")) {
          if (alive.current) setCheck(existing);
          return;
        }
      } catch {
        /* fall through: starting reports its own error */
      }
      await begin();
    })();
  }, [begin, client, session.id]);

  // While the questions are being written, read the state every few seconds.
  const generating = check?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const timer = setTimeout(async () => {
      try {
        const next = await getSessionCheck(client, session.id);
        if (alive.current && next) setCheck(next);
      } catch (e) {
        if (alive.current) setError(friendlyMessage(e, "Could not check on the questions. Please try again."));
      }
    }, CHECK_POLL_MS);
    return () => clearTimeout(timer);
  }, [generating, check, client, session.id]);

  async function submit() {
    if (!check?.questions) return;
    setBusy("submit");
    setError(null);
    try {
      const res = await submitSessionCheck(
        client,
        session.id,
        check.id,
        check.questions.map((q) => ({ questionId: q.id, choice: picked[q.id]! })),
      );
      if (!alive.current) return;
      setCheck(res.check);
      if (res.check.passed) await onPassed();
    } catch (e) {
      if (alive.current) setError(friendlyMessage(e, "Your answers could not be sent. Please try again."));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const answeredAll = check?.questions ? check.questions.every((q) => picked[q.id] !== undefined) : false;

  return (
    <div>
      <p className="text-sm text-slate-600">
        Before this session is marked complete, answer {SESSION_CHECK_QUESTIONS} quick questions about <span className="font-medium text-slate-900">{session.topic}</span>. You need {SESSION_CHECK_PASS} correct.
      </p>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {(busy === "start" || (check?.status === "generating" && !error)) && (
        <div role="status" className="mt-5 flex items-center gap-3 text-sm text-slate-700">
          <Spinner className="h-5 w-5" />
          <span>Writing your questions with the local AI. This can take a minute or two.</span>
        </div>
      )}

      {check?.status === "error" && (
        <div className="mt-4 space-y-3">
          <Alert tone="error">{check.error}</Alert>
          <div className="flex gap-2">
            <Button onClick={() => void begin()} loading={busy === "start"}>
              Try again
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Back
            </Button>
          </div>
        </div>
      )}

      {check?.status === "ready" && check.questions && (
        <form
          className="mt-4 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (answeredAll) void submit();
          }}
        >
          {check.isMock && <Alert tone="info">Demo questions: the local AI isn&apos;t running, so these are placeholders, not real questions about your topic.</Alert>}
          {check.questions.map((q, i) => (
            <fieldset key={q.id}>
              <legend className="text-sm font-medium text-slate-900">
                {i + 1}. {q.text}
              </legend>
              <div className="mt-2 space-y-1.5">
                {q.options.map((option, idx) => (
                  <label key={idx} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl px-3 py-2 text-sm ring-1 transition ${picked[q.id] === idx ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>
                    <input type="radio" name={`q-${q.id}`} checked={picked[q.id] === idx} onChange={() => setPicked((p) => ({ ...p, [q.id]: idx }))} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand-600)]" />
                    <span>
                      <span className="mr-1.5 font-medium">{LETTERS[idx]}.</span>
                      {option}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-600">
              {Object.keys(picked).length} of {SESSION_CHECK_QUESTIONS} answered
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy !== null}>
                Cancel
              </Button>
              <Button type="submit" disabled={!answeredAll} loading={busy === "submit"}>
                Submit answers
              </Button>
            </div>
          </div>
        </form>
      )}

      {(check?.status === "passed" || check?.status === "failed") && check.review && check.questions && (
        <div className="mt-4 space-y-4">
          <Alert tone={check.passed ? "success" : "error"}>
            {check.passed
              ? `You scored ${check.score} out of ${check.total} - this session is now complete. Well done!`
              : `You scored ${check.score} out of ${check.total}; you need ${check.passMark}. The session is not complete yet. Look through the answers below, revisit the topic, then try a new set.`}
          </Alert>
          <ol className="space-y-3">
            {check.questions.map((q, i) => {
              const r = check.review!.find((x) => x.questionId === q.id)!;
              const right = r.chosen === r.correctIndex;
              return (
                <li key={q.id} className="rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200">
                  <p className="font-medium text-slate-900">
                    {i + 1}. {q.text}
                  </p>
                  <p className={`mt-1 ${right ? "text-emerald-800" : "text-red-800"}`}>
                    {right ? "Correct" : `Your answer: ${r.chosen === null ? "none" : `${LETTERS[r.chosen]}. ${q.options[r.chosen]}`}`}
                  </p>
                  {!right && (
                    <p className="text-slate-800">
                      Correct answer: {LETTERS[r.correctIndex]}. {q.options[r.correctIndex]}
                    </p>
                  )}
                  {r.explanation && <p className="mt-1 text-slate-600">{r.explanation}</p>}
                </li>
              );
            })}
          </ol>
          <div className="flex gap-2">
            {check.passed ? (
              <Button onClick={onCancel}>Done</Button>
            ) : (
              <>
                <Button onClick={() => void begin()} loading={busy === "start"}>
                  Try a new set
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                  Back to session
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
