import { useId } from "react";
import type { PlayQuestion } from "@copilot/shared";
import { OPTION_LETTERS, QUESTION_DIFFICULTY_LABEL } from "./format";

interface Props {
  question: PlayQuestion;
  number: number;
  total: number;
  selected: number | null;
  onSelect: (index: number) => void;
  onClear: () => void;
  disabled?: boolean;
}

/**
 * One question. The options are real radio buttons in a fieldset whose legend is the question,
 * so it works with a keyboard (arrow keys) and a screen reader. There is no hint of the answer here:
 * the browser does not have it.
 */
export function QuestionCard({ question, number, total, selected, onSelect, onClear, disabled }: Props) {
  const name = useId();
  return (
    <section aria-label={`Question ${number} of ${total}`} className="relative overflow-hidden rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-8">
      {/* How far through the quiz this question is. Decorative: the text above already says "Question n of N". */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-slate-100">
        <div className="h-full rounded-r-full bg-gradient-to-r from-brand-500 to-violet-500 transition-all duration-300" style={{ width: `${(number / total) * 100}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs font-medium text-slate-600">
        <span className="rounded-full bg-brand-50 px-2.5 py-1 font-semibold text-brand-700">
          Question {number} of {total}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-1">{QUESTION_DIFFICULTY_LABEL[question.difficulty]}</span>
        {question.topic && <span className="max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1">{question.topic}</span>}
        {question.type === "true_false" && <span className="rounded-full bg-slate-100 px-2.5 py-1">True / False</span>}
      </div>

      <fieldset className="mt-4 min-w-0" disabled={disabled}>
        <legend className="text-lg font-semibold leading-relaxed tracking-tight text-slate-900 sm:text-[1.35rem] sm:leading-snug">{question.text}</legend>
        <div className="mt-5 space-y-2.5">
          {question.options.map((option, i) => {
            const checked = selected === i;
            return (
              <label
                key={i}
                className={`flex min-h-14 cursor-pointer items-start gap-3.5 rounded-2xl px-4 py-3.5 text-[15px] leading-snug ring-1 transition duration-150 hover:-translate-y-px hover:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
                  checked ? "bg-brand-50 text-slate-900 ring-2 ring-brand-600" : "bg-white text-slate-800 ring-slate-300 hover:bg-slate-50"
                }`}
              >
                <input type="radio" name={name} checked={checked} onChange={() => onSelect(i)} className="sr-only" />
                <span aria-hidden="true" className={`mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${checked ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-700"}`}>
                  {question.type === "true_false" ? (i === 0 ? "T" : "F") : OPTION_LETTERS[i]}
                </span>
                <span className="min-w-0 flex-1 break-words">{option}</span>
                {/* Selection is shown by a check mark and a thicker border, not by colour alone. */}
                {checked && (
                  <svg viewBox="0 0 16 16" className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5l3.2 3L13 4.5" />
                  </svg>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 min-h-6 text-sm">
        {selected !== null ? (
          <button type="button" onClick={onClear} disabled={disabled} className="rounded font-medium text-slate-600 underline hover:text-slate-900">
            Clear my answer
          </button>
        ) : (
          <span className="text-slate-600">Not answered yet</span>
        )}
      </div>
    </section>
  );
}
