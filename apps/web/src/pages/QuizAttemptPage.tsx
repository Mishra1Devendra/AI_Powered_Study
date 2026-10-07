import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { ProgressBar } from "../components/ui/ProgressBar";
import { QuestionCard } from "../features/quiz/QuestionCard";
import { QuestionNav } from "../features/quiz/QuestionNav";
import { SubmitDialog } from "../features/quiz/SubmitDialog";
import { TimerBadge } from "../features/quiz/TimerBadge";
import { QuizProvenance } from "../features/quiz/QuizStatusBadge";
import { useQuizPaths } from "../features/quiz/paths";
import { useAttempt } from "../features/quiz/useAttempt";
import { LoadingState } from "../components/ui/LoadingState";

/** `/quiz/attempt/:attemptId`: answering the questions. */
export default function QuizAttemptPage() {
  const p = useQuizPaths();
  const { attemptId = "" } = useParams<{ attemptId: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const a = useAttempt(client, attemptId);
  const [confirming, setConfirming] = useState(false);
  const { goTo, choose, index, questions } = a;
  const current = questions[index];

  // Keyboard: A-D (or 1-4) choose an answer, N / P move between questions. Ignored while typing in a field,
  // with a modifier held, or while the submit dialog is open.
  useEffect(() => {
    if (confirming || !current) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input:not([type=radio]), textarea, select, [contenteditable=true]")) return;
      const key = e.key.toLowerCase();
      const n = /^[1-9]$/.test(key) ? Number(key) - 1 : /^[a-f]$/.test(key) ? key.charCodeAt(0) - 97 : -1;
      if (n >= 0 && n < current.options.length) {
        e.preventDefault();
        choose(current.id, n);
      } else if (key === "n") goTo(index + 1);
      else if (key === "p") goTo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, current, choose, goTo, index]);

  // Once the server has graded the attempt, move on to the result (carrying it, so nothing is fetched twice).
  useEffect(() => {
    if (a.result) navigate(p.result(attemptId), { replace: true, state: { result: a.result } });
  }, [a.result, attemptId, navigate]);

  if (a.load.status === "loading") {
    return (
      <LoadingState label="Loading your quiz…" />
    );
  }
  if (a.load.status === "error") {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <Alert tone="error">{a.load.message}</Alert>
        <div className="flex gap-2">
          {!a.load.notFound && <Button variant="secondary" onClick={() => void a.reload()}>Try again</Button>}
          <Link to={p.home} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">
            Back to quizzes
          </Link>
        </div>
      </div>
    );
  }

  const { view } = a.load;
  // Already submitted or timed out (e.g. opened from history or a stale tab): show the result instead.
  if (view.attempt.status !== "in_progress") return <Navigate to={p.result(attemptId)} replace />;

  const total = a.questions.length;
  const q = a.questions[a.index]!;
  const last = a.index === total - 1;

  const saveText = a.saveState === "saving" ? "Saving…" : a.saveState === "saved" ? "All answers saved" : a.saveState === "error" ? "Couldn't save your latest answer" : "";

  return (
    <div className="animate-fade-up mx-auto max-w-5xl">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900">{view.quiz.title}</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>
              {a.answeredCount} of {total} answered
            </span>
            <QuizProvenance isMock={view.quiz.isMock} model={view.quiz.model} />
          </p>
        </div>
        <div className="flex items-center gap-3">
          {a.remaining !== null && <TimerBadge remaining={a.remaining} />}
          <Button className="h-10" onClick={() => setConfirming(true)} disabled={a.submitting}>
            Submit quiz
          </Button>
        </div>
      </header>

      <div className="mt-3">
        <ProgressBar value={total === 0 ? 0 : (a.answeredCount / total) * 100} label={`${a.answeredCount} of ${total} questions answered`} />
        <p role="status" aria-live="polite" className={`mt-1.5 min-h-5 text-xs ${a.saveState === "error" ? "font-medium text-red-700" : "text-slate-600"}`}>
          {saveText}
          {a.saveState === "error" && (
            <button type="button" onClick={() => void a.retrySave()} className="ml-2 font-semibold underline">
              Retry
            </button>
          )}
        </p>
      </div>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div>
          <QuestionCard question={q} number={a.index + 1} total={total} selected={a.answers[q.id] ?? null} onSelect={(i) => a.choose(q.id, i)} onClear={() => a.choose(q.id, null)} disabled={a.submitting} />
          <p className="mt-3 hidden text-xs text-slate-600 sm:block">
            Keyboard: press <kbd className="rounded border border-slate-300 bg-white px-1 font-mono">A</kbd>–<kbd className="rounded border border-slate-300 bg-white px-1 font-mono">D</kbd> to choose an answer, <kbd className="rounded border border-slate-300 bg-white px-1 font-mono">N</kbd> for next and <kbd className="rounded border border-slate-300 bg-white px-1 font-mono">P</kbd> for previous.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <Button variant="secondary" onClick={() => a.goTo(a.index - 1)} disabled={a.index === 0}>
              ← Previous
            </Button>
            {last ? (
              <Button onClick={() => setConfirming(true)} disabled={a.submitting}>
                Review &amp; submit
              </Button>
            ) : (
              <Button onClick={() => a.goTo(a.index + 1)}>Next →</Button>
            )}
          </div>
        </div>
        <aside aria-label="Question navigator" className="rounded-(--radius-card) bg-white p-4 shadow-card ring-1 ring-slate-200/70 lg:sticky lg:top-6 lg:self-start">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Questions</h2>
          <QuestionNav questions={a.questions} answers={a.answers} current={a.index} onGo={a.goTo} />
        </aside>
      </div>

      {confirming && (
        <SubmitDialog
          total={total}
          answered={a.answeredCount}
          submitting={a.submitting}
          error={a.submitError}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void a.submit()}
          onReviewUnanswered={() => {
            const first = a.questions.findIndex((x) => a.answers[x.id] === undefined);
            setConfirming(false);
            if (first >= 0) a.goTo(first);
          }}
        />
      )}
    </div>
  );
}
