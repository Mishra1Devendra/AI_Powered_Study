import { TutorAvatar } from "./MessageItem";

/** One short line under each starter so the choices are not just a label. Display only. */
const STARTER_HINT: Record<string, string> = {
  "Explain a difficult topic": "Break an idea into clear steps",
  "Help me solve a problem": "Work through it together",
  "Prepare me for an exam": "A focused revision plan",
  "Test my understanding": "Quick questions on what you studied",
  "Explain this in simple language": "No jargon, plain words",
};

export const STARTERS = [
  { label: "Explain a difficult topic", text: "Explain a difficult topic to me: " },
  { label: "Help me solve a problem", text: "Help me solve this problem: " },
  { label: "Prepare me for an exam", text: "Help me prepare for my exam on " },
  { label: "Test my understanding", text: "Test my understanding of " },
  { label: "Explain this in simple language", text: "Explain this in simple language: " },
] as const;

/** First-visit state. Starters fill the composer for the student to finish; nothing is sent or saved. */
export function EmptyTutor({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-4 py-8 text-center">
      <span className="relative flex">
        <span aria-hidden="true" className="absolute -inset-4 rounded-full bg-brand-600/15 blur-xl" />
        <TutorAvatar className="relative h-14 w-14 ring-8 ring-brand-50" />
      </span>
      <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">What are you studying today?</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
        Ask a question, share a problem, or pick a starting point. Your tutor explains, then helps you practise and check your understanding.
      </p>
      <ul className="mt-7 grid w-full gap-3 text-left sm:grid-cols-2">
        {STARTERS.map((s, i) => (
          <li key={s.label} className={i === STARTERS.length - 1 && STARTERS.length % 2 === 1 ? "sm:col-span-2" : ""}>
            <button
              type="button"
              onClick={() => onPick(s.text)}
              aria-label={s.label}
              className="group flex min-h-16 w-full flex-col justify-center rounded-2xl bg-white px-4 py-3 ring-1 ring-slate-200 transition duration-200 hover:-translate-y-0.5 hover:bg-brand-50 hover:shadow-md hover:ring-brand-100"
            >
              <span className="text-sm font-semibold text-slate-900 group-hover:text-brand-700">{s.label}</span>
              <span className="mt-0.5 text-xs text-slate-600">{STARTER_HINT[s.label] ?? ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
