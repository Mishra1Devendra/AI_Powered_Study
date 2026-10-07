import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { QUESTION_TYPE_LABEL } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { LinkButton } from "../components/ui/LinkButton";
import { LoadingState } from "../components/ui/LoadingState";
import { formatDate } from "../features/notes/format";
import { GenerationSteps } from "../features/quiz/GenerationSteps";
import { ATTEMPT_STATUS_LABEL, DIFFICULTY_LABEL, formatDuration, formatPercent } from "../features/quiz/format";
import { QuizProvenance, QuizStatusBadge } from "../features/quiz/QuizStatusBadge";
import { useQuizDetail } from "../features/quiz/useQuizData";
import { useQuizPaths } from "../features/quiz/paths";
import { regenerateQuiz, retryQuiz, startQuiz } from "../lib/quizApi";

/** Seconds since `since`, ticking once a second while `active`. */
function useElapsed(since: string | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, 1000);
    };
    t = setTimeout(tick, 1000);
    return () => clearTimeout(t);
  }, [active]);
  return since ? Math.max(0, (now - new Date(since).getTime()) / 1000) : 0;
}

/** `/quiz/:quizId`: while the quiz is being written, when it is ready to start, or when it failed. */
export default function QuizDetailPage() {
  const p = useQuizPaths();
  const { quizId = "" } = useParams<{ quizId: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const detail = useQuizDetail(client, quizId);
  const [pending, setPending] = useState<"start" | "again" | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quiz = detail.state.status === "ready" ? detail.state.data.quiz : null;
  const elapsed = useElapsed(quiz?.createdAt ?? null, quiz?.status === "generating");

  async function run(kind: "start" | "again" | "new", fn: () => Promise<string>) {
    setPending(kind);
    setError(null);
    try {
      navigate(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }

  const back = (
    <Link to={p.home} className="-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
      <span aria-hidden="true">←</span> All quizzes
    </Link>
  );

  if (detail.state.status === "loading") {
    return (
      <div className="space-y-4">
        {back}
        <LoadingState label="Loading quiz…" />
      </div>
    );
  }
  if (detail.state.status === "error") {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        {back}
        <Alert tone="error">{detail.notFound ? "This quiz doesn't exist or was removed." : detail.state.message}</Alert>
        {!detail.notFound && (
          <Button variant="secondary" onClick={() => void detail.reload()}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  const { quiz: q, questions, attempts } = detail.state.data;
  const finished = attempts.filter((a) => a.status !== "in_progress" && a.percentage !== null);
  const open = attempts.find((a) => a.status === "in_progress");

  return (
    <div className="animate-fade-up mx-auto max-w-3xl space-y-6">
      {back}
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">{q.title}</h1>
          <QuizStatusBadge status={q.status} />
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {q.sourceLabel} · {q.questionCount} questions · {DIFFICULTY_LABEL[q.difficulty]} · {q.questionTypes.map((t) => QUESTION_TYPE_LABEL[t]).join(", ")}
          {q.timeLimitMinutes ? ` · ${q.timeLimitMinutes} min timer` : ""}
        </p>
        {q.status === "ready" && (
          <p className="mt-2">
            <QuizProvenance isMock={q.isMock} model={q.model} />
          </p>
        )}
      </header>

      {q.status === "generating" && (
        <section aria-label="Creating your quiz" className="rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <GenerationSteps progress={q.progress} />
          <p className="mt-4 text-sm text-slate-700">
            {q.questionCount} questions requested. <span className="text-slate-600">{formatDuration(elapsed)} so far.</span>
          </p>
          <p className="mt-1 text-sm text-slate-600">A local AI writes a few questions at a time, then each one is checked, so this can take several minutes. You can leave this page; your quiz keeps being made and will appear in your list.</p>
        </section>
      )}

      {q.status === "failed" && (
        <section aria-label="Quiz could not be created" className="space-y-4 rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Quiz generation failed</h2>
          <Alert tone="error">{q.error ?? "The quiz couldn't be created."}</Alert>
          <p className="text-sm text-slate-600">No questions from this attempt were saved, and your other quizzes are unaffected. You can retry with the same settings, or change them (fewer questions usually works better with a small local AI).</p>
          <div className="flex flex-wrap gap-2">
            <Button loading={pending === "new"} onClick={() => void run("new", async () => p.quiz((await regenerateQuiz(client, q.id)).id))}>
              Retry
            </Button>
            <LinkButton to={p.create} variant="secondary">
              Change settings
            </LinkButton>
          </div>
        </section>
      )}

      {q.status === "ready" && (
        <section aria-label="Start this quiz" className="rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">{open ? "Pick up where you left off" : finished.length > 0 ? "Go again" : "Ready when you are"}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {questions.length} questions. You can move between questions, change answers, and submit when you&apos;re done.
            {q.timeLimitMinutes ? ` You have ${q.timeLimitMinutes} minutes once you start.` : ""}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              loading={pending === "start"}
              onClick={() =>
                void run("start", async () => {
                  const v = open || finished.length === 0 ? await startQuiz(client, q.id) : await retryQuiz(client, q.id);
                  return p.attempt(v.attempt.id);
                })
              }
            >
              {open ? "Resume quiz" : finished.length > 0 ? "Retry this quiz" : "Start quiz"}
            </Button>
            <Button variant="secondary" loading={pending === "again"} onClick={() => void run("again", async () => p.quiz((await regenerateQuiz(client, q.id)).id))}>
              New questions
            </Button>
          </div>
          {finished.length > 0 && <p className="mt-2 text-xs text-slate-600">&ldquo;Retry&rdquo; reuses these questions in a new order. &ldquo;New questions&rdquo; writes a fresh quiz from the same source.</p>}
        </section>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {attempts.length > 0 && (
        <section aria-label="Attempts">
          <h2 className="text-base font-semibold tracking-tight text-slate-900">Your attempts</h2>
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
            {attempts.map((a) => (
              <li key={a.id}>
                <Link to={a.status === "in_progress" ? p.attempt(a.id) : p.result(a.id)} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50 sm:px-5">
                  <span className="text-sm text-slate-700">{formatDate(a.submittedAt ?? a.startedAt)}</span>
                  <span className="text-sm font-semibold text-slate-900">
                    {a.status === "in_progress" ? "In progress · Resume" : `${a.score}/${a.total} · ${formatPercent(a.percentage ?? 0)}`}
                    {a.status === "expired" && <span className="ml-2 text-xs font-normal text-slate-600">{ATTEMPT_STATUS_LABEL.expired}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
