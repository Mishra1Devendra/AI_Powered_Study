import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { QuizResult, ReviewItem } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { LinkButton } from "../components/ui/LinkButton";
import { explainPrompt } from "../features/quiz/format";
import { QuizProvenance } from "../features/quiz/QuizStatusBadge";
import { ReviewList } from "../features/quiz/ReviewList";
import { ScoreCard } from "../features/quiz/ScoreCard";
import { TopicPerformance } from "../features/quiz/TopicPerformance";
import { ApiError } from "../lib/api";
import { useQuizPaths } from "../features/quiz/paths";
import { getResult, regenerateQuiz, retryQuiz } from "../lib/quizApi";
import { LoadingState } from "../components/ui/LoadingState";

type State = { status: "loading" } | { status: "error"; message: string; notSubmitted: boolean; notFound: boolean } | { status: "ready"; result: QuizResult };

/** `/quiz/attempt/:attemptId/result`: score, breakdown, and every question reviewed. */
export default function QuizResultPage() {
  const p = useQuizPaths();
  const { attemptId = "" } = useParams<{ attemptId: string }>();
  const { client } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const carried = (location.state as { result?: QuizResult } | null)?.result;
  const [state, setState] = useState<State>(carried && carried.attempt.id === attemptId ? { status: "ready", result: carried } : { status: "loading" });
  const [pending, setPending] = useState<"retry" | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", result: await getResult(client, attemptId) });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setState({ status: "error", message: e instanceof Error ? e.message : "Could not load your result.", notSubmitted: status === 409, notFound: status === 404 });
    }
  }, [client, attemptId]);

  useEffect(() => {
    if (state.status === "loading") void load();
    // only on mount / attempt change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  if (state.status === "loading") {
    return (
      <LoadingState label="Calculating your results…" />
    );
  }
  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <Alert tone="error">{state.notFound ? "This result doesn't exist." : state.message}</Alert>
        <div className="flex gap-2">
          {state.notSubmitted && <LinkButton to={p.attempt(attemptId)}>Continue the quiz</LinkButton>}
          {!state.notFound && !state.notSubmitted && <Button variant="secondary" onClick={() => void load()}>Try again</Button>}
          <Link to={p.home} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">
            Back to quizzes
          </Link>
        </div>
      </div>
    );
  }

  const { result } = state;
  const quiz = result.quiz;

  async function retry() {
    setPending("retry");
    setActionError(null);
    try {
      const v = await retryQuiz(client, quiz.id);
      navigate(p.attempt(v.attempt.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }
  async function freshQuestions() {
    setPending("new");
    setActionError(null);
    try {
      navigate(p.quiz((await regenerateQuiz(client, quiz.id)).id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }
  /** Hands the question to the existing AI Tutor as a ready-to-send message; nothing is sent automatically. */
  function askAi(item: ReviewItem) {
    navigate(p.tutor, { state: { draft: explainPrompt(item), subject: quiz.subject, topic: item.topic ?? quiz.topic } });
  }

  return (
    <div className="animate-fade-up mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={p.home} className="-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
          <span aria-hidden="true">←</span> All quizzes
        </Link>
        <QuizProvenance isMock={quiz.isMock} model={quiz.model} />
      </div>
      <h1 className="sr-only">Results: {quiz.title}</h1>

      <ScoreCard result={result} />

      <p className="rounded-xl bg-slate-50 px-4 py-2.5 text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200">
        {quiz.isMock
          ? "These were placeholder demo questions, not written by a real AI, so the score says nothing about what you know."
          : "These questions were written by an AI running on your computer and checked by the app, but a small AI can still get things wrong. If an answer looks off, compare it with your notes or use “Ask AI to explain”."}
      </p>

      <section aria-label="What to do next" className="flex flex-wrap items-center gap-2">
        <Button loading={pending === "retry"} onClick={() => void retry()}>
          Retry quiz
        </Button>
        <Button variant="secondary" loading={pending === "new"} onClick={() => void freshQuestions()}>
          New questions
        </Button>
        <LinkButton to={p.create} variant="ghost">
          Create another quiz
        </LinkButton>
      </section>
      {actionError && <Alert tone="error">{actionError}</Alert>}

      <TopicPerformance topics={result.topics} />
      <ReviewList review={result.review} onAskAi={askAi} />
    </div>
  );
}
