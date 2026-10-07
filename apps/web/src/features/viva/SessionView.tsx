import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { VIVA_LIMITS, type VivaDetail } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { abandonViva, answerViva, nextViva } from "../../lib/vivaApi";
import { Dialog } from "../planner/Dialog";
import { DifficultyBadge, ProvenanceBadge, SourceBadge } from "./Badges";
import { Evaluation } from "./Evaluation";
import { DISCLAIMER, currentQuestion, title } from "./format";
import { useVivaPaths } from "./paths";

const draftKey = (questionId: string) => `viva-draft-${questionId}`;
const readDraft = (questionId: string) => {
  try {
    return sessionStorage.getItem(draftKey(questionId)) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (questionId: string, value: string) => {
  try {
    if (value) sessionStorage.setItem(draftKey(questionId), value);
    else sessionStorage.removeItem(draftKey(questionId));
  } catch {
    /* storage can be unavailable (private window): the text simply stays in the page */
  }
};
const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

type Busy = "evaluating" | "next" | "ending" | null;

/** An unfinished viva: the examiner's question, the answer box, then the evaluation and "Next question". */
export function SessionView({ detail, onUpdate }: { detail: VivaDetail; onUpdate: (d: VivaDetail) => void }) {
  const { client } = useAuth();
  const p = useVivaPaths();
  const navigate = useNavigate();
  const { session, questions } = detail;
  const q = currentQuestion(questions);
  const answered = q.answer !== null;
  const isLast = q.number >= session.questionCount;

  const [text, setText] = useState(() => readDraft(q.id));
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ text: string; retry: () => void } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // State updates are not visible until the next render, so a fast double click needs a synchronous guard.
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // A new question mounts a fresh view (see the key in VivaSessionPage): start at the question.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  // The evaluation arrived: move focus to the next action.
  useEffect(() => {
    if (answered) nextBtn.current?.focus();
  }, [answered]);

  async function run(kind: Exclude<Busy, null>, action: () => Promise<VivaDetail>, then?: (d: VivaDetail) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError(null);
    try {
      const d = await action();
      then?.(d);
      onUpdate(d);
    } catch (e) {
      setError({ text: message(e), retry: () => void run(kind, action, then) });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const trimmed = text.trim();
  const tooLong = text.length > VIVA_LIMITS.answerMaxChars;
  const submit = () => {
    if (!trimmed || tooLong) return;
    void run("evaluating", () => answerViva(client, session.id, { questionId: q.id, answer: trimmed }), () => writeDraft(q.id, ""));
  };

  const status =
    busy === "evaluating" ? (isLast ? "Evaluating your answer and saving your result…" : "Evaluating your answer…") : busy === "next" ? "Preparing the next question…" : busy === "ending" ? "Ending this viva…" : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
          <span aria-hidden="true">←</span> Leave for now
        </Link>
        <Button variant="ghost" className="h-10 px-3 text-slate-600" onClick={() => setConfirmEnd(true)} disabled={busy !== null}>
          End viva
        </Button>
      </div>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceBadge isMock={session.isMock} model={session.model} />
          <DifficultyBadge d={session.difficulty} />
          <SourceBadge sourceType={session.sourceType} documentTitle={session.documentTitle} />
        </div>
        <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight text-slate-900">{title(session)}</h1>
        <div className="mt-3" role="group" aria-label={`Question ${q.number} of ${session.questionCount}`}>
          <p className="text-sm font-semibold text-slate-800">
            Question {q.number} of {session.questionCount}
            {q.isFollowUp && <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-200">Follow-up</span>}
          </p>
          <ol className="mt-2 flex gap-1.5" aria-hidden="true">
            {Array.from({ length: session.questionCount }, (_, i) => (
              <li key={i} className={`h-1.5 flex-1 rounded-full ${i + 1 < q.number || (i + 1 === q.number && answered) ? "bg-brand-600" : i + 1 === q.number ? "bg-brand-300" : "bg-slate-200"}`} />
            ))}
          </ol>
        </div>
      </header>

      <section aria-labelledby="examiner-q" className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
        <p id="examiner-q" className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Examiner
        </p>
        <h2 ref={heading} tabIndex={-1} className="mt-2 break-words text-xl font-semibold leading-snug tracking-tight text-slate-900 focus:outline-none sm:text-2xl">
          {q.text}
        </h2>

        {!answered ? (
          <form
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="viva-answer" className="mb-1.5 block text-sm font-semibold text-slate-900">
              Your answer
            </label>
            <textarea
              id="viva-answer"
              ref={box}
              value={text}
              rows={7}
              readOnly={busy !== null}
              aria-describedby="viva-answer-help"
              onChange={(e) => {
                setText(e.target.value);
                writeDraft(q.id, e.target.value);
              }}
              placeholder="Type your answer… explain it as you would to an examiner."
              className="block w-full resize-y rounded-xl bg-white p-3.5 text-base leading-relaxed text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600 read-only:bg-slate-50 sm:text-sm"
            />
            <p id="viva-answer-help" className={`mt-1.5 text-xs ${tooLong ? "text-red-700" : "text-slate-600"}`}>
              {text.length} / {VIVA_LIMITS.answerMaxChars} characters. Your text is kept here if something goes wrong.
            </p>
            <div className="mt-4">
              <Button type="submit" loading={busy === "evaluating"} disabled={busy !== null || !trimmed || tooLong} className="w-full sm:w-auto">
                Submit Answer
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="rounded-xl bg-slate-50 px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Your answer</h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{q.answer!.answerText}</p>
            </div>
            <Evaluation answer={q.answer!} keyPoints={q.keyPoints} subject={session.subject} concept={q.concept} />
            <div>
              <Button ref={nextBtn} onClick={() => void run("next", () => nextViva(client, session.id))} loading={busy === "next"} disabled={busy !== null} className="w-full sm:w-auto">
                Next Question
              </Button>
            </div>
          </div>
        )}

        {status && (
          <div role="status" aria-live="polite" className="mt-5 flex items-start gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-900">
            <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong className="font-semibold">{status}</strong>
              <span className="block text-brand-800">Your local AI is working on this. It can take a minute or more.</span>
            </span>
          </div>
        )}
        {error && (
          <div className="mt-5 space-y-2">
            <Alert tone="error">{error.text}</Alert>
            <Button variant="secondary" onClick={error.retry} disabled={busy !== null}>
              Try again
            </Button>
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-slate-600">{DISCLAIMER}</p>

      {confirmEnd && (
        <Dialog title="End this viva?" onClose={() => setConfirmEnd(false)} busy={busy === "ending"}>
          <p className="text-sm text-slate-700">Your answers so far stay in your history, but an unfinished viva does not get a score. You can start a new one any time.</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" data-initial-focus onClick={() => setConfirmEnd(false)} disabled={busy === "ending"}>
              Keep going
            </Button>
            <Button
              loading={busy === "ending"}
              onClick={() => void run("ending", () => abandonViva(client, session.id), () => navigate(p.home))}
            >
              End viva
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
