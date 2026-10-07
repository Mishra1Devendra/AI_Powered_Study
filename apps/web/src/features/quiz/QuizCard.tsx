import { useState } from "react";
import { Link } from "react-router";
import type { Quiz } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../dashboard/format";
import { IndeterminateBar } from "../notes/StatusBadge";
import { DIFFICULTY_LABEL, formatPercent } from "./format";
import { describeProgress } from "./GenerationSteps";
import { useQuizPaths } from "./paths";
import { QuizProvenance, QuizStatusBadge } from "./QuizStatusBadge";

interface Props {
  quiz: Quiz;
  now: Date;
  /** Starts (or resumes) an attempt and opens it. Rejects with a student-readable message. */
  onStart: (quiz: Quiz) => Promise<void>;
  /** Makes a new quiz with the same settings (for a quiz that failed). */
  onRecreate: (quiz: Quiz) => Promise<void>;
}

export function QuizCard({ quiz, now, onStart, onRecreate }: Props) {
  const p = useQuizPaths();
  const [pending, setPending] = useState<"start" | "recreate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "start" | "recreate", fn: () => Promise<void>) {
    setPending(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setPending(null);
    }
  }

  const meta = [quiz.sourceLabel, `${quiz.questionCount} questions`, DIFFICULTY_LABEL[quiz.difficulty], quiz.timeLimitMinutes ? `${quiz.timeLimitMinutes} min` : null].filter(Boolean).join(" · ");
  const resume = quiz.inProgressAttemptId !== null;

  return (
    <li className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-500/30 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h3 className="min-w-0 text-base font-semibold tracking-tight text-slate-900">
          <Link to={p.quiz(quiz.id)} className="break-words rounded hover:text-brand-700 hover:underline">
            {quiz.title}
          </Link>
        </h3>
        <QuizStatusBadge status={quiz.status} />
      </div>
      <p className="mt-1 text-sm text-slate-600">{meta}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
        <span>Created {relativeTime(quiz.createdAt, now).toLowerCase()}</span>
        {quiz.status === "ready" && quiz.attemptCount > 0 && (
          <span>
            · {quiz.attemptCount} {quiz.attemptCount === 1 ? "attempt" : "attempts"}
            {quiz.bestPercentage !== null && <> · best {formatPercent(quiz.bestPercentage)}</>}
          </span>
        )}
        {quiz.status === "ready" && <QuizProvenance isMock={quiz.isMock} model={quiz.model} />}
      </p>

      {quiz.status === "generating" && (
        <div className="mt-3 max-w-sm">
          <IndeterminateBar label="Creating quiz" />
          <p role="status" className="mt-1.5 text-xs text-slate-600">
            {describeProgress(quiz.progress)} A local AI can take a few minutes.
          </p>
        </div>
      )}
      {quiz.status === "failed" && quiz.error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {quiz.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {quiz.status === "ready" && (
          <Button className="h-9 px-4" loading={pending === "start"} onClick={() => void run("start", () => onStart(quiz))}>
            {resume ? "Resume quiz" : quiz.attemptCount > 0 ? "Retry quiz" : "Start quiz"}
          </Button>
        )}
        {quiz.status === "failed" && (
          <Button variant="secondary" className="h-9 px-4" loading={pending === "recreate"} onClick={() => void run("recreate", () => onRecreate(quiz))}>
            Retry
          </Button>
        )}
        <Link to={p.quiz(quiz.id)} className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Details
        </Link>
      </div>
    </li>
  );
}
