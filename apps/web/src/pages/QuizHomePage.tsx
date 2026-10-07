import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Quiz } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState } from "../components/ui/EmptyState";
import { LinkButton } from "../components/ui/LinkButton";
import { EmblemBadge } from "../components/ui/EmblemBadge";
import { QuizIcon, SparkIcon } from "../components/ui/Icons";
import { LoadingState } from "../components/ui/LoadingState";
import { HistoryList } from "../features/quiz/HistoryList";
import { PerformanceSummary } from "../features/quiz/PerformanceSummary";
import { QuizCard } from "../features/quiz/QuizCard";
import { useAttemptHistory, useQuizHome } from "../features/quiz/useQuizData";
import { useQuizPaths } from "../features/quiz/paths";
import { regenerateQuiz, retryQuiz, startQuiz } from "../lib/quizApi";
import { ErrorState } from "../components/ui/ErrorState";

type Tab = "quizzes" | "history";

function Loading({ label }: { label: string }) {
  return <LoadingState label={label} shape="list" />;
}

function HistoryTab() {
  const { client } = useAuth();
  const history = useAttemptHistory(client);
  if (history.state.status === "loading") return <Loading label="Loading your history…" />;
  if (history.state.status === "error") {
    return (
      <ErrorState message={history.state.message} onRetry={() => void history.reload()} />
    );
  }
  if (history.state.data.length === 0) {
    return (
      <EmptyState title="No attempts yet" icon={<QuizIcon />}>
        When you take a quiz, each attempt, with its score and date, will be kept here.
      </EmptyState>
    );
  }
  return <HistoryList attempts={history.state.data} />;
}

/** `/quiz`: your quizzes, your results, and the way to make a new one. */
export default function QuizHomePage() {
  const p = useQuizPaths();
  const { client } = useAuth();
  const navigate = useNavigate();
  const home = useQuizHome(client);
  const [tab, setTab] = useState<Tab>("quizzes");
  const now = useMemo(() => new Date(), [home.state]);

  async function onStart(quiz: Quiz) {
    const view = quiz.inProgressAttemptId || quiz.attemptCount === 0 ? await startQuiz(client, quiz.id) : await retryQuiz(client, quiz.id);
    navigate(p.attempt(view.attempt.id));
  }
  async function onRecreate(quiz: Quiz) {
    const next = await regenerateQuiz(client, quiz.id);
    navigate(p.quiz(next.id));
  }

  const data = home.state.status === "ready" ? home.state.data : null;
  const resumeable = data?.quizzes.find((q) => q.inProgressAttemptId);

  return (
    <div className="animate-fade-up">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quiz</h1>
          <p className="mt-1 text-sm text-slate-600">Test what you know, see where you slip, and fix it.</p>
        </div>
        <LinkButton to={p.create}>
          <SparkIcon className="h-4 w-4" /> Create Quiz
        </LinkButton>
      </header>

      {home.state.status === "loading" && <Loading label="Loading your quizzes…" />}
      {home.state.status === "error" && (
        <div className="mt-6"><ErrorState message={home.state.message} onRetry={() => void home.reload()} /></div>
      )}

      {data && (
        <div className="mt-6 space-y-6">
          {resumeable?.inProgressAttemptId && (
            <div role="region" aria-label="Quiz in progress" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-50 px-5 py-4 ring-1 ring-brand-100">
              <p className="text-sm text-brand-700">
                <span className="font-semibold">You have a quiz in progress:</span> {resumeable.title}
              </p>
              <LinkButton to={p.attempt(resumeable.inProgressAttemptId)} size="sm">
                Resume
              </LinkButton>
            </div>
          )}

          {data.quizzes.length === 0 ? (
            <div className="rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70">
              <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-14 text-center">
                <EmblemBadge>
                  <QuizIcon className="h-7 w-7" />
                </EmblemBadge>
                <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-slate-900">Turn your notes into practice questions.</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">Pick your notes or a topic, choose how hard it should be, and get a quiz with explanations and a breakdown of what to revise.</p>
                <LinkButton to={p.create} className="mt-6">
                  Create your first quiz
                </LinkButton>
              </div>
            </div>
          ) : (
            <>
              <PerformanceSummary summary={data.summary} />
              <div>
                <div role="tablist" aria-label="Quiz sections" className="inline-flex rounded-xl bg-slate-100 p-1">
                  {(
                    [
                      ["quizzes", "My quizzes"],
                      ["history", "History"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} role="tab" type="button" id={`quiz-tab-${id}`} aria-selected={tab === id} aria-controls={`quiz-panel-${id}`} onClick={() => setTab(id)} className={`h-10 rounded-lg px-5 text-sm font-medium transition ${tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div id={`quiz-panel-${tab}`} role="tabpanel" aria-labelledby={`quiz-tab-${tab}`} className="mt-4">
                  {tab === "quizzes" ? (
                    <ul className="space-y-3">
                      {data.quizzes.map((q) => (
                        <QuizCard key={q.id} quiz={q} now={now} onStart={onStart} onRecreate={onRecreate} />
                      ))}
                    </ul>
                  ) : (
                    <HistoryTab />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
