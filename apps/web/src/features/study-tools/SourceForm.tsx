import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { STUDY_TOOLS_LIMITS, type QuizOptions, type StudySource } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";

export const fieldClass = "h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600";

type Kind = "notes" | "topic";

interface Props {
  /** The student's ready notes and suggested topics (the same options the quiz form uses). */
  options: QuizOptions;
  submitLabel: string;
  /** Options that belong to this tool only (how many cards, how big a map). Rendered above the button. */
  extra?: ReactNode;
  error?: string | null;
  /** A note to start on (arrives from "Make flashcards" on a note). Only pre-selected; nothing starts until the button is pressed. */
  prefillDocumentId?: string | undefined;
  /** Starts the job. May reject with a student-readable message. */
  onSubmit: (source: StudySource, title: string | undefined) => Promise<void>;
}

/** Where the cards or the map come from: the student's own notes (with an optional focus), or a subject they type. */
export function SourceForm({ options, submitLabel, extra, error, prefillDocumentId, onSubmit }: Props) {
  const uid = useId();
  const hasNotes = options.notes.length > 0;
  const prefilled = prefillDocumentId && options.notes.some((n) => n.id === prefillDocumentId) ? prefillDocumentId : "";
  const [kind, setKind] = useState<Kind>(prefilled || hasNotes ? "notes" : "topic");
  const [noteIds, setNoteIds] = useState<string[]>(prefilled ? [prefilled] : []);
  const [focus, setFocus] = useState("");
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const problem = useMemo(() => {
    if (kind === "notes" && noteIds.length === 0) return "Choose at least one note.";
    if (kind === "topic" && subject.trim() === "") return "Enter a subject.";
    return null;
  }, [kind, noteIds, subject]);

  const toggle = (id: string) => setNoteIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < STUDY_TOOLS_LIMITS.maxNotes ? [...cur, id] : cur));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    try {
      const source: StudySource =
        kind === "topic"
          ? { type: "topic", subject: subject.trim(), ...(topic.trim() ? { topic: topic.trim() } : {}) }
          : { type: "notes", documentIds: noteIds, ...(focus.trim() ? { focus: focus.trim() } : {}) };
      await onSubmit(source, title.trim() || undefined);
    } finally {
      setBusy(false);
    }
  }

  const tab = (k: Kind, label: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === k}
      disabled={disabled}
      onClick={() => setKind(k)}
      className={`h-10 rounded-lg px-4 text-sm font-medium transition ${kind === k ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"} disabled:cursor-not-allowed disabled:text-slate-400`}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      <div>
        <p className="text-sm font-semibold text-slate-900">What should it be made from?</p>
        <div role="radiogroup" aria-label="Source" className="mt-2 inline-flex gap-1 rounded-xl bg-slate-100 p-1">
          {tab("notes", "My notes", !hasNotes)}
          {tab("topic", "A subject")}
        </div>
        {!hasNotes && (
          <p className="mt-2 text-sm text-slate-600">
            You haven&apos;t got any processed notes yet.{" "}
            <Link to="/notes" className="font-medium text-brand-700 underline">
              Upload notes
            </Link>
          </p>
        )}
      </div>

      {kind === "notes" && (
        <div className="space-y-3">
          <fieldset>
            <legend className="text-sm font-medium text-slate-800">
              Choose up to {STUDY_TOOLS_LIMITS.maxNotes} notes <span className="font-normal text-slate-600">({noteIds.length} chosen)</span>
            </legend>
            <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {options.notes.map((n) => {
                const checked = noteIds.includes(n.id);
                const full = !checked && noteIds.length >= STUDY_TOOLS_LIMITS.maxNotes;
                return (
                  <li key={n.id}>
                    <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm ring-1 transition ${checked ? "bg-brand-50 font-medium text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"} ${full ? "cursor-not-allowed opacity-50" : ""}`}>
                      <input type="checkbox" checked={checked} disabled={full} onChange={() => toggle(n.id)} className="h-4 w-4 accent-brand-600" />
                      <span className="min-w-0 flex-1 truncate">{n.title}</span>
                      <span className="shrink-0 text-xs font-normal text-slate-500">{n.pageCount ? `${n.pageCount} pages` : `${n.chunkCount} sections`}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <div>
            <label htmlFor={`${uid}-focus`} className="text-sm font-medium text-slate-800">
              Focus on <span className="font-normal text-slate-600">(optional)</span>
            </label>
            <input id={`${uid}-focus`} value={focus} maxLength={STUDY_TOOLS_LIMITS.focusMaxChars} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. photosynthesis, chapter 3" className={`mt-1.5 ${fieldClass}`} />
          </div>
        </div>
      )}

      {kind === "topic" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-subject`} className="text-sm font-medium text-slate-800">
              Subject
            </label>
            <input id={`${uid}-subject`} value={subject} maxLength={STUDY_TOOLS_LIMITS.subjectMaxChars} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Biology" list={`${uid}-subjects`} className={`mt-1.5 ${fieldClass}`} aria-invalid={touched && kind === "topic" && subject.trim() === "" ? true : undefined} />
            <datalist id={`${uid}-subjects`}>
              {[...new Set(options.topics.map((t) => t.subject))].slice(0, 8).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor={`${uid}-topic`} className="text-sm font-medium text-slate-800">
              Topic <span className="font-normal text-slate-600">(optional)</span>
            </label>
            <input id={`${uid}-topic`} value={topic} maxLength={STUDY_TOOLS_LIMITS.topicMaxChars} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Cell division" className={`mt-1.5 ${fieldClass}`} />
          </div>
        </div>
      )}

      <div>
        <label htmlFor={`${uid}-title`} className="text-sm font-medium text-slate-800">
          Name <span className="font-normal text-slate-600">(optional, we will suggest one)</span>
        </label>
        <input id={`${uid}-title`} value={title} maxLength={STUDY_TOOLS_LIMITS.titleMaxChars} onChange={(e) => setTitle(e.target.value)} className={`mt-1.5 ${fieldClass}`} />
      </div>

      {extra}

      {touched && problem && <Alert tone="error">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <Button type="submit" loading={busy} className="w-full sm:w-auto">
        {submitLabel}
      </Button>
    </form>
  );
}
