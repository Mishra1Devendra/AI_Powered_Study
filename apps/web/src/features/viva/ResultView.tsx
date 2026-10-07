import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { DIMENSIONS, DIMENSION_LABEL, SCORE_LEVEL_LABEL, SCORE_WEIGHTS, scoreLevel, type VivaDetail } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Spinner } from "../../components/ui/Spinner";
import { createViva } from "../../lib/vivaApi";
import { DifficultyBadge, Meter, ProvenanceBadge, ScoreBadge, SourceBadge } from "./Badges";
import { QuestionReview } from "./Evaluation";
import { DIMENSION_HINT, DISCLAIMER, LEVEL_STYLE, longDate, outOf100, tutorDraft, title } from "./format";
import { useVivaPaths } from "./paths";

/** The results of a completed viva: the score, the breakdown, strong areas, what to improve, and every question. */
export function ResultView({ detail }: { detail: VivaDetail }) {
  const { client } = useAuth();
  const p = useVivaPaths();
  const navigate = useNavigate();
  const { session, questions, result } = detail;
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);

  if (!result || session.score === null) return null;
  const level = scoreLevel(result.overall);
  const style = LEVEL_STYLE[level];

  /** "Practice Again": a NEW viva with the same settings. The old one is kept untouched. */
  async function again() {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    try {
      const d = await createViva(client, { subject: session.subject, ...(session.topic ? { topic: session.topic } : {}), difficulty: session.difficulty, questionCount: session.questionCount, ...(session.sourceType && session.sourceType !== "general" ? { sourceType: session.sourceType } : {}), ...(session.sourceType === "document" && session.documentId ? { documentId: session.documentId } : {}) });
      navigate(p.session(d.session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> All vivas
      </Link>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceBadge isMock={session.isMock} model={session.model} />
          <DifficultyBadge d={session.difficulty} />
          <SourceBadge sourceType={session.sourceType} documentTitle={session.documentTitle} />
          <span className="text-xs text-slate-600">{session.completedAt ? longDate(session.completedAt) : ""}</span>
        </div>
        <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight text-slate-900">{title(session)}</h1>
        <p className="text-sm text-slate-600">Viva complete · {session.questionCount} questions</p>

        <div className="mt-5 flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Overall score</p>
            <p className="text-5xl font-semibold tracking-tight text-slate-900" aria-label={`Overall score ${Math.round(result.overall)} out of 100`}>
              {Math.round(result.overall)}
              <span className="text-2xl font-medium text-slate-500"> / 100</span>
            </p>
          </div>
          <p className="pb-1.5">
            <ScoreBadge score={result.overall} />
          </p>
        </div>
        <div className="mt-3 h-1.5 w-full max-w-md rounded-full bg-slate-100" aria-hidden="true">
          <div className="h-full rounded-full" style={{ width: `${Math.max(2, result.overall)}%`, backgroundColor: style.bar }} />
        </div>
        <p className="sr-only">{SCORE_LEVEL_LABEL[level]}. {outOf100(result.overall)}</p>

        <h2 className="mt-7 text-base font-semibold text-slate-900">Performance breakdown</h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          {DIMENSIONS.map((d) => (
            <div key={d}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <dt className="text-slate-700">{DIMENSION_LABEL[d]}</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{Math.round(result.dimensions[d])}%</dd>
              </div>
              <div className="mt-1">
                <Meter value={result.dimensions[d]} label={`${DIMENSION_LABEL[d]}: ${Math.round(result.dimensions[d])} percent`} />
              </div>
              {DIMENSION_HINT[d] && <p className="mt-1 text-xs text-slate-600">{DIMENSION_HINT[d]}</p>}
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-slate-600">
          Score = {Math.round(SCORE_WEIGHTS.correctness * 100)}% understanding + {Math.round(SCORE_WEIGHTS.completeness * 100)}% completeness + {Math.round(SCORE_WEIGHTS.clarity * 100)}% clarity + {Math.round(SCORE_WEIGHTS.confidence * 100)}% confidence,
          averaged over your answers. A simple weighting, not a validated measure. {DISCLAIMER}
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-slate-900">Strong areas</h2>
          {result.strongAreas.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
              {result.strongAreas.map((s) => (
                <li key={s} className="break-words">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">No answer reached the strong line (75%) this time.</p>
          )}
        </Card>
        <Card>
          <h2 className="text-base font-semibold text-slate-900">Needs improvement</h2>
          {result.improveAreas.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-800">
              {result.improveAreas.map((s) => (
                <li key={s} className="break-words">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Nothing stood out as weak in your answers.</p>
          )}
          {result.weakConcepts.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {result.weakConcepts.slice(0, 3).map((c) => (
                <Button
                  key={c}
                  variant="secondary"
                  className="h-10 px-3.5"
                  aria-label={`Ask AI Tutor about ${c}`}
                  onClick={() => navigate(p.tutor, { state: { draft: tutorDraft(c, session.subject), subject: session.subject, topic: c } })}
                >
                  Ask AI Tutor: {c}
                </Button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void again()} loading={starting}>
          Practice Again
        </Button>
        <Link to={p.home} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
          All vivas
        </Link>
        <p className="text-xs text-slate-600">Practice Again starts a new viva with the same settings. This one is kept.</p>
      </div>
      {starting && (
        <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="font-semibold">Preparing your Viva…</strong>
            <span className="block">The examiner is preparing your first question. Your local AI can take a minute or more.</span>
          </span>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <section aria-labelledby="review-h">
        <h2 id="review-h" className="text-base font-semibold text-slate-900">
          Review your answers
        </h2>
        <ol className="mt-3 space-y-4">
          {questions.map((q) => (
            <QuestionReview key={q.id} q={q} subject={session.subject} />
          ))}
        </ol>
      </section>
    </div>
  );
}
