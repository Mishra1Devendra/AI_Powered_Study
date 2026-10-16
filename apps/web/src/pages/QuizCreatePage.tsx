import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { GenerateQuizInput } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { CreateQuizForm } from "../features/quiz/CreateQuizForm";
import { QuizProvenance } from "../features/quiz/QuizStatusBadge";
import { useQuizOptions } from "../features/quiz/useQuizData";
import { ApiError } from "../lib/api";
import { generateQuiz } from "../lib/quizApi";
import { AI_COST } from "@copilot/shared";
import { AiUsageNote } from "../features/ai-usage/AiUsageNote";
import { useQuizPaths } from "../features/quiz/paths";
import { fetchHealth } from "../lib/tutorApi";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";

/** `/quiz/new`: choose what to be quizzed on, then hand over to the "creating your quiz" page. */
export default function QuizCreatePage() {
  const p = useQuizPaths();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // From "Practice Topic" on the Progress page: only text for the form, length-limited. Nothing starts by itself.
  const prefill = { subject: params.get("subject")?.slice(0, 100) ?? undefined, topic: params.get("topic")?.slice(0, 100) ?? undefined, count: Number(params.get("count")) || undefined, documentId: params.get("document")?.slice(0, 64) ?? undefined };
  const options = useQuizOptions(client);
  const [error, setError] = useState<string | null>(null);
  const [busyQuizId, setBusyQuizId] = useState<string | null>(null);
  const [ai, setAi] = useState<{ isMock: boolean; model: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => setAi({ isMock: h.ai.isMock, model: h.ai.model }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function onSubmit(input: GenerateQuizInput) {
    setError(null);
    setBusyQuizId(null);
    try {
      const quiz = await generateQuiz(client, input);
      navigate(p.quiz(quiz.id));
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        if (typeof e.body?.quizId === "string") setBusyQuizId(e.body.quizId);
      } else {
        setError("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <div className="animate-fade-up mx-auto max-w-3xl">
      <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> All quizzes
      </Link>
      <header className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create a quiz</h1>
          <p className="mt-1 text-sm text-slate-600">Tell us what to ask about. The questions are written for you in a moment.</p>
        </div>
        {ai && (
          <div className="text-right text-xs text-slate-600">
            Written by
            <div className="mt-1">
              <QuizProvenance isMock={ai.isMock} model={ai.model} />
            </div>
          </div>
        )}
      </header>
      <AiUsageNote cost={AI_COST.quiz} className="mt-4" />
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        When enabled, quiz prompts and relevant note passages are sent to Google Gemini for processing. Google&apos;s unpaid-tier terms say submitted content may be used to improve products and may be reviewed by humans. AI generation is currently unavailable while model free-tier eligibility is unverified.
      </p>

      <div className="mt-6 rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-7">
        {options.state.status === "loading" && (
          <LoadingState label="Loading…" />
        )}
        {options.state.status === "error" && (
          <ErrorState message={options.state.message} onRetry={() => void options.reload()} />
        )}
        {options.state.status === "ready" && <CreateQuizForm options={options.state.data} onSubmit={onSubmit} error={error} busyQuizId={busyQuizId} prefill={prefill} />}
      </div>
    </div>
  );
}
