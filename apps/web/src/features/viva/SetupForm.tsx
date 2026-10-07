import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SOURCE_MODE_LABEL, VIVA_DIFFICULTIES, VIVA_DIFFICULTY_LABEL, VIVA_LIMITS, createVivaInputSchema, type CreateVivaRequest, type SourceMode, type VivaDifficulty, type VivaOptions } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";

interface Props {
  options: VivaOptions | null;
  /** Starts the viva. Rejects with a student-readable message. */
  onStart: (input: CreateVivaRequest) => Promise<void>;
  /** The settings to start from (e.g. "Practice again"). */
  initial?: Partial<CreateVivaRequest> | undefined;
  error?: string | null;
}

const field = "h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600";
const DIFFICULTY_HINT: Record<VivaDifficulty, string> = { easy: "Core ideas in plain words", medium: "Why and how", hard: "Apply, compare, justify" };

/** A big, tappable choice that is a real radio underneath (keyboard and screen-reader friendly). */
function Choice({ name, checked, onChange, children, hint }: { name: string; checked: boolean; onChange: () => void; children: ReactNode; hint?: string }) {
  return (
    <label
      className={`relative flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
        checked ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-brand-600 bg-brand-600" : "border-slate-400 bg-white"}`}>
        {checked && (
          <svg viewBox="0 0 16 16" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.5l3 3 6-6.5" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="block text-xs font-normal text-slate-600">{hint}</span>}
      </span>
    </label>
  );
}

export function SetupForm({ options, onStart, initial, error }: Props) {
  const ids = useId();
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [difficulty, setDifficulty] = useState<VivaDifficulty>(initial?.difficulty ?? "medium");
  const [count, setCount] = useState<number>(initial?.questionCount ?? VIVA_LIMITS.defaultQuestions);
  const documents = options?.documents ?? [];
  const [sourceType, setSourceType] = useState<SourceMode>(initial?.sourceType ?? "general");
  const [documentId, setDocumentId] = useState<string>(initial?.documentId ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // State updates are not visible until the next render, so a fast double click needs a synchronous guard.
  const inFlight = useRef(false);

  const subjects = [...new Set((options?.topics ?? []).map((t) => t.subject))];
  const topics = [...new Set((options?.topics ?? []).filter((t) => t.topic && (!subject.trim() || t.subject.toLowerCase() === subject.trim().toLowerCase())).map((t) => t.topic!))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setLocalError(null);
    // A viva on one document does not need a typed subject: the document's name is used.
    if (sourceType === "document" && !documentId) return setLocalError("Choose a document.");
    const chosen = documents.find((d) => d.id === documentId);
    const subjectText = subject.trim() || (sourceType === "document" ? (chosen?.title.slice(0, VIVA_LIMITS.subjectMaxChars) ?? "") : "");
    const parsed = createVivaInputSchema.safeParse({ subject: subjectText, ...(topic.trim() ? { topic } : {}), difficulty, questionCount: count, sourceType, ...(sourceType === "document" ? { documentId } : {}) });
    if (!parsed.success) return setLocalError(parsed.error.issues[0]?.message ?? "Please check the form.");
    inFlight.current = true;
    setStarting(true);
    try {
      // A general viva is sent exactly as it always was; a source is only named when one was chosen.
      const { sourceType: chosenSource, documentId: chosenDocument, ...rest } = parsed.data;
      await onStart(chosenSource === "general" ? rest : { ...rest, sourceType: chosenSource, ...(chosenDocument ? { documentId: chosenDocument } : {}) });
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }

  const shown = localError ?? error ?? null;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
      <datalist id={`${ids}-subjects`}>
        {subjects.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id={`${ids}-topics`}>
        {topics.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <fieldset className="min-w-0" disabled={starting}>
        <legend className="text-sm font-semibold text-slate-900">What should the questions be based on?</legend>
        <div role="radiogroup" aria-label="Viva source" className="mt-2.5 grid gap-2 sm:grid-cols-3">
          <Choice name="source" checked={sourceType === "general"} onChange={() => setSourceType("general")} hint="The AI's own knowledge">
            {SOURCE_MODE_LABEL.general}
          </Choice>
          <Choice name="source" checked={sourceType === "notes"} onChange={() => documents.length > 0 && setSourceType("notes")} hint={documents.length > 0 ? "Your uploaded material" : "Upload notes first"}>
            {SOURCE_MODE_LABEL.notes}
          </Choice>
          <Choice name="source" checked={sourceType === "document"} onChange={() => documents.length > 0 && setSourceType("document")} hint={documents.length > 0 ? "Just one of your documents" : "Upload notes first"}>
            {SOURCE_MODE_LABEL.document}
          </Choice>
        </div>
        {sourceType === "document" && (
          <div className="mt-3">
            <label htmlFor={`${ids}-document`} className="mb-1.5 block text-sm font-semibold text-slate-900">
              Document
            </label>
            <select id={`${ids}-document`} className={field} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">Choose a document…</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>
        )}
        {sourceType !== "general" && <p className="mt-2 text-xs text-slate-600">Questions are based on passages from your material, and your answers are judged with that passage as a guide. The local AI can still make mistakes.</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${ids}-subject`} className="mb-1.5 block text-sm font-semibold text-slate-900">
            Subject{sourceType === "document" && <span className="font-normal text-slate-600"> (optional - the document&apos;s name is used)</span>}
          </label>
          <input id={`${ids}-subject`} list={`${ids}-subjects`} className={field} value={subject} maxLength={VIVA_LIMITS.subjectMaxChars} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Chemistry" disabled={starting} />
        </div>
        <div>
          <label htmlFor={`${ids}-topic`} className="mb-1.5 block text-sm font-semibold text-slate-900">
            Topic <span className="font-normal text-slate-600">(optional)</span>
          </label>
          <input id={`${ids}-topic`} list={`${ids}-topics`} className={field} value={topic} maxLength={VIVA_LIMITS.topicMaxChars} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Reaction rates" disabled={starting} />
        </div>
      </div>

      <fieldset className="min-w-0" disabled={starting}>
        <legend className="text-sm font-semibold text-slate-900">Difficulty</legend>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
          {VIVA_DIFFICULTIES.map((d) => (
            <Choice key={d} name="difficulty" checked={difficulty === d} onChange={() => setDifficulty(d)} hint={DIFFICULTY_HINT[d]}>
              {VIVA_DIFFICULTY_LABEL[d]}
            </Choice>
          ))}
        </div>
      </fieldset>

      <fieldset className="min-w-0" disabled={starting}>
        <legend className="text-sm font-semibold text-slate-900">Number of questions</legend>
        <p className="mt-0.5 text-xs text-slate-600">Your local AI is slow on modest hardware, so 5 is recommended. Each question and each evaluation takes a moment.</p>
        <div className="mt-2.5 grid grid-cols-3 gap-2">
          {VIVA_LIMITS.questionOptions.map((n) => (
            <Choice key={n} name="count" checked={count === n} onChange={() => setCount(n)} hint={n === VIVA_LIMITS.defaultQuestions ? "Recommended" : undefined}>
              {n} questions
            </Choice>
          ))}
        </div>
      </fieldset>

      {shown && <Alert tone="error">{shown}</Alert>}

      <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-600">Text only. Questions and feedback come from your local AI; nothing is sent to a paid service.</p>
        <Button type="submit" loading={starting} className="w-full sm:w-auto">
          {starting ? "Preparing…" : "Start Viva"}
        </Button>
      </div>
    </form>
  );
}
