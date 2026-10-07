import { useNavigate } from "react-router";
import { DIMENSIONS, DIMENSION_LABEL, type VivaAnswer, type VivaQuestion } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { Meter, ScoreBadge } from "./Badges";
import { DIMENSION_HINT, tutorDraft } from "./format";
import { useVivaPaths } from "./paths";

/** The four 0-10 scores with the answer score, the feedback and the missing concepts. Everything is the AI's advisory evaluation. */
export function Evaluation({ answer, keyPoints, subject, concept }: { answer: VivaAnswer; keyPoints: string[] | null; subject: string; concept: string }) {
  const p = useVivaPaths();
  const navigate = useNavigate();
  const ask = (c: string) => navigate(p.tutor, { state: { draft: tutorDraft(c, subject), subject, topic: c } });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900">Evaluation <span className="font-normal text-slate-600">(AI-generated)</span></h4>
        <ScoreBadge score={answer.score} />
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {DIMENSIONS.map((d) => (
          <div key={d}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <dt className="text-slate-700" title={DIMENSION_HINT[d]}>
                {DIMENSION_LABEL[d]}
              </dt>
              <dd className="font-semibold tabular-nums text-slate-900">{answer[d]}/10</dd>
            </div>
            <div className="mt-1">
              <Meter value={answer[d] * 10} label={`${DIMENSION_LABEL[d]}: ${answer[d]} out of 10`} />
            </div>
          </div>
        ))}
      </dl>
      <div>
        <h4 className="text-sm font-semibold text-slate-900">Feedback</h4>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{answer.feedback}</p>
      </div>
      {answer.missingConcepts.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Missing concepts</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-800">
            {answer.missingConcepts.map((m) => (
              <li key={m} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
      {keyPoints && keyPoints.length > 0 && (
        <div className="rounded-xl bg-slate-50 px-4 py-3">
          <h4 className="text-sm font-semibold text-slate-900">What a strong answer covers <span className="font-normal text-slate-600">(AI-generated)</span></h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-800">
            {keyPoints.map((k) => (
              <li key={k} className="break-words">
                {k}
              </li>
            ))}
          </ul>
        </div>
      )}
      {answer.missingConcepts.length > 0 && (
        <div>
          <Button variant="secondary" className="h-10" onClick={() => ask(answer.missingConcepts[0]!)} aria-label={`Ask AI Tutor about ${answer.missingConcepts[0]}`}>
            Ask AI Tutor
          </Button>
          <p className="mt-1 text-xs text-slate-600">Opens the Tutor with a suggested question about &quot;{answer.missingConcepts[0]}&quot;. Nothing is sent until you press send there.</p>
        </div>
      )}
      <span className="sr-only">Concept tested: {concept}</span>
    </div>
  );
}

export function QuestionReview({ q, subject }: { q: VivaQuestion; subject: string }) {
  return (
    <li className="rounded-2xl bg-white p-4 ring-1 ring-slate-200 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Question {q.number}</h3>
        {q.isFollowUp && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-violet-200">Follow-up</span>}
        <span className="text-xs text-slate-600">Tests: {q.concept}</span>
      </div>
      <p className="mt-2 break-words text-base font-medium leading-snug text-slate-900">{q.text}</p>
      {q.answer ? (
        <>
          <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Your answer</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{q.answer.answerText}</p>
          </div>
          <div className="mt-4">
            <Evaluation answer={q.answer} keyPoints={q.keyPoints} subject={subject} concept={q.concept} />
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-600">This question was not answered.</p>
      )}
    </li>
  );
}
