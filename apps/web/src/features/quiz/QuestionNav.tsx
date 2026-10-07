import type { PlayQuestion } from "@copilot/shared";

interface Props {
  questions: PlayQuestion[];
  answers: Record<string, number>;
  current: number;
  onGo: (index: number) => void;
}

/** Numbered jump grid. Answered / unanswered / current are shown with text-equivalent labels, not colour alone. */
export function QuestionNav({ questions, answers, current, onGo }: Props) {
  return (
    <nav aria-label="Question navigator">
      <div className="mb-3">
        <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-all duration-300" style={{ width: `${questions.length ? (Object.keys(answers).length / questions.length) * 100 : 0}%` }} />
        </div>
      </div>
      <ol className="grid grid-cols-5 gap-2 sm:grid-cols-6 lg:grid-cols-5">
        {questions.map((q, i) => {
          const answered = answers[q.id] !== undefined;
          const isCurrent = i === current;
          return (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => onGo(i)}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`Question ${i + 1}, ${answered ? "answered" : "not answered"}${isCurrent ? ", current" : ""}`}
                className={`relative flex h-11 w-full items-center justify-center rounded-xl text-sm font-semibold ring-1 transition duration-150 hover:-translate-y-px ${
                  isCurrent
                    ? "bg-brand-600 text-white ring-brand-600"
                    : answered
                      ? "bg-brand-50 text-brand-700 ring-brand-100 hover:bg-brand-100"
                      : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
                }`}
              >
                {i + 1}
                {answered && !isCurrent && (
                  <svg viewBox="0 0 16 16" className="absolute right-1 top-1 h-2.5 w-2.5 text-brand-600" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5l3.2 3L13 4.5" />
                  </svg>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-hidden="true">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-brand-600" /> Current
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-brand-50 ring-1 ring-brand-100" /> Answered
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-white ring-1 ring-slate-300" /> Not answered
        </li>
      </ul>
    </nav>
  );
}
