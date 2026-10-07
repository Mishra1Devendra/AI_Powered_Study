import { useState } from "react";
import type { ReviewItem } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { OPTION_LETTERS, QUESTION_DIFFICULTY_LABEL } from "./format";

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[8.5rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600 sm:pt-0.5">{label}</dt>
      <dd className={`text-sm leading-relaxed ${tone === "good" ? "font-medium text-emerald-900" : tone === "bad" ? "font-medium text-red-900" : "text-slate-800"}`}>{children}</dd>
    </div>
  );
}

const choiceText = (item: ReviewItem, i: number | null) => (i === null ? null : `${item.type === "true_false" ? (i === 0 ? "True" : "False") : `${OPTION_LETTERS[i]}.`} ${item.type === "true_false" ? "" : item.options[i]}`.trim());

type Filter = "all" | "mistakes";

interface Props {
  review: ReviewItem[];
  /** Opens the AI Tutor with this question ready to discuss. */
  onAskAi: (item: ReviewItem) => void;
}

function outcome(item: ReviewItem): { label: string; classes: string; icon: "check" | "x" | "dash" } {
  if (item.isCorrect) return { label: "Correct", classes: "bg-emerald-50 text-emerald-800 ring-emerald-200", icon: "check" };
  if (item.selected === null) return { label: "Skipped", classes: "bg-slate-100 text-slate-700 ring-slate-200", icon: "dash" };
  return { label: "Incorrect", classes: "bg-red-50 text-red-800 ring-red-200", icon: "x" };
}

const ICON_PATH = { check: "M3 8.5l3.2 3L13 4.5", x: "M4 4l8 8M12 4l-8 8", dash: "M4 8h8" } as const;

function ReviewCard({ item, onAskAi }: { item: ReviewItem; onAskAi: (item: ReviewItem) => void }) {
  const o = outcome(item);
  return (
    <li className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5">
      <article aria-label={`Question ${item.order + 1}: ${o.label}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-600">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold uppercase tracking-wide ring-1 ${o.classes}`}>
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={ICON_PATH[o.icon]} />
            </svg>
            {o.label}
          </span>
          <span>Question {item.order + 1}</span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1">{QUESTION_DIFFICULTY_LABEL[item.difficulty]}</span>
          {item.topic && <span className="max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1">{item.topic}</span>}
        </div>

        <h3 className="mt-3 text-base font-semibold leading-snug text-slate-900">{item.text}</h3>

        <ul className="mt-3 space-y-2">
          {item.options.map((option, i) => {
            const isCorrect = i === item.correctAnswer;
            const isMine = i === item.selected;
            return (
              <li
                key={i}
                className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 text-sm ring-1 ${
                  isCorrect ? "bg-emerald-50 text-slate-900 ring-emerald-300" : isMine ? "bg-red-50 text-slate-900 ring-red-300" : "bg-white text-slate-700 ring-slate-200"
                }`}
              >
                <span aria-hidden="true" className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-700 ring-1 ring-slate-300">
                  {item.type === "true_false" ? (i === 0 ? "T" : "F") : OPTION_LETTERS[i]}
                </span>
                <span className="min-w-0 flex-1 break-words">{option}</span>
                {/* Text labels, so meaning never depends on colour. */}
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs font-semibold">
                  {isCorrect && <span className="text-emerald-800">Correct answer</span>}
                  {isMine && <span className={isCorrect ? "text-emerald-800" : "text-red-800"}>Your answer</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {item.selected === null && <p className="mt-2 text-sm text-slate-600">You didn&apos;t answer this question.</p>}

        <dl className="mt-3 space-y-2 rounded-xl bg-slate-50 px-4 py-3">
          <Fact label="You answered" tone={item.isCorrect ? "good" : item.selected === null ? undefined : "bad"}>
            {choiceText(item, item.selected) ?? "Nothing. You skipped this question."}
          </Fact>
          {!item.isCorrect && <Fact label="Correct answer" tone="good">{choiceText(item, item.correctAnswer)}</Fact>}
          <Fact label="Why">{item.explanation}</Fact>
          {(item.topic || item.difficulty) && (
            <Fact label="Concept">
              {item.topic ?? "Unclassified"} <span className="text-slate-600">· {QUESTION_DIFFICULTY_LABEL[item.difficulty]}</span>
            </Fact>
          )}
          {item.source?.evidence && (
            <Fact label="From your notes">
              <q className="italic">{item.source.evidence}</q>
              <span className="mt-0.5 block text-xs text-slate-600">{[item.source.title, item.source.page !== null ? `p. ${item.source.page}` : null, item.source.heading].filter(Boolean).join(" · ")}</span>
            </Fact>
          )}
        </dl>
        {!item.source?.evidence && item.source && (item.source.page !== null || item.source.heading || item.source.title) && (
          <p className="mt-2 text-xs text-slate-600">
            From your notes: {[item.source.title, item.source.page !== null ? `p. ${item.source.page}` : null, item.source.heading].filter(Boolean).join(" · ")}
          </p>
        )}

        {!item.isCorrect && (
          <div className="mt-3">
            <Button variant="secondary" className="h-9 px-3.5" onClick={() => onAskAi(item)}>
              Ask AI to explain
            </Button>
          </div>
        )}
      </article>
    </li>
  );
}

/** Every question with the student's answer, the right one and why. "Mistakes" narrows it to what to revise. */
export function ReviewList({ review, onAskAi }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const mistakes = review.filter((r) => !r.isCorrect);
  const shown = filter === "all" ? review : mistakes;
  return (
    <section aria-label="Question review">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-slate-900">Review your answers</h2>
        <div role="group" aria-label="Show" className="inline-flex rounded-xl bg-slate-100 p-1">
          {(
            [
              ["all", `All (${review.length})`],
              ["mistakes", `Mistakes (${mistakes.length})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`h-9 rounded-lg px-4 text-sm font-medium transition ${filter === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-emerald-50 px-5 py-6 text-center text-sm text-emerald-900">No mistakes to review. Every question was answered correctly.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {shown.map((item) => (
            <ReviewCard key={item.id} item={item} onAskAi={onAskAi} />
          ))}
        </ul>
      )}
    </section>
  );
}
