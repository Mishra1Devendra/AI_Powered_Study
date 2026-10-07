import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  DIFFICULTIES,
  GENERATABLE_QUESTION_TYPES,
  QUESTION_TYPE_LABEL,
  QUIZ_LIMITS,
  type Difficulty,
  type GenerateQuizInput,
  type GeneratableQuestionType,
  type QuizOptions,
} from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { useQuizPaths } from "./paths";
import { DIFFICULTY_LABEL } from "./format";

/** Phase 11: General knowledge ("topic"), all/several of My notes ("notes"), or one Specific document ("document"). */
type SourceKind = "notes" | "topic" | "document";

interface Props {
  options: QuizOptions;
  /** Starts the quiz. Rejects with a student-readable message; may carry the id of a quiz already being made. */
  onSubmit: (input: GenerateQuizInput) => Promise<void>;
  /** A running generation the server reported, so we can link to it. */
  busyQuizId?: string | null;
  error?: string | null;
  /** Start on "a subject or topic" with these filled in (e.g. from a weak topic on the Progress page). Nothing is generated until Create is pressed. */
  prefill?: { subject?: string; topic?: string; count?: number; documentId?: string } | undefined;
}

const field = "h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600";

function Group({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-semibold text-slate-900">{legend}</legend>
      {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </fieldset>
  );
}

/** A big, tappable choice that is a real radio/checkbox underneath (keyboard and screen-reader friendly). */
function Choice({ type, name, checked, disabled, onChange, children, hint }: { type: "radio" | "checkbox"; name: string; checked: boolean; disabled?: boolean; onChange: () => void; children: ReactNode; hint?: string }) {
  return (
    <label
      className={`relative flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
        disabled ? "cursor-not-allowed bg-slate-50 text-slate-500 ring-slate-200" : checked ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
      }`}
    >
      <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} className="sr-only" />
      <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center border ${type === "radio" ? "rounded-full" : "rounded"} ${checked ? "border-brand-600 bg-brand-600" : "border-slate-400 bg-white"}`}>
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

export function CreateQuizForm({ options, onSubmit, busyQuizId, error, prefill }: Props) {
  const p = useQuizPaths();
  const uid = useId();
  const hasNotes = options.notes.length > 0;
  // "Make a quiz" from a note arrives with that document; it is only pre-selected (and only if it is really one of the student's ready notes).
  const prefilledDocument = prefill?.documentId && options.notes.some((n) => n.id === prefill.documentId) ? prefill.documentId : "";
  const [source, setSource] = useState<SourceKind>(prefilledDocument ? "document" : prefill?.topic || prefill?.subject ? "topic" : hasNotes ? "notes" : "topic");
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [documentId, setDocumentId] = useState(prefilledDocument);
  const [focus, setFocus] = useState("");
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [topic, setTopic] = useState(prefill?.topic ?? "");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [count, setCount] = useState<number>(prefill?.count && (QUIZ_LIMITS.countOptions as readonly number[]).includes(prefill.count) ? prefill.count : QUIZ_LIMITS.defaultCount);
  const [types, setTypes] = useState<GeneratableQuestionType[]>(["mcq"]);
  const [timeLimit, setTimeLimit] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const problem = useMemo(() => {
    if (source === "notes" && noteIds.length === 0) return "Choose at least one note.";
    if (source === "document" && documentId === "") return "Choose a document.";
    if (source === "topic" && subject.trim() === "") return "Enter a subject.";
    if (types.length === 0) return "Choose at least one question type.";
    return null;
  }, [source, noteIds, documentId, subject, types]);

  const toggleNote = (id: string) => setNoteIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < QUIZ_LIMITS.maxNotes ? [...cur, id] : cur));
  const toggleType = (t: GeneratableQuestionType) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (problem || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        source:
          source === "topic"
            ? { type: "topic", subject: subject.trim(), ...(topic.trim() ? { topic: topic.trim() } : {}) }
            : { type: "notes", documentIds: source === "document" ? [documentId] : noteIds, ...(focus.trim() ? { focus: focus.trim() } : {}) },
        difficulty,
        count,
        questionTypes: types,
        timeLimitMinutes: timeLimit,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-8">
      <Group legend="What do you want to be quizzed on?">
        <div role="radiogroup" aria-label="Quiz source" className="grid gap-2 sm:grid-cols-3">
          <Choice type="radio" name={`${uid}-source`} checked={source === "topic"} onChange={() => setSource("topic")} hint="The AI's own knowledge, not a document">
            General knowledge
          </Choice>
          <Choice type="radio" name={`${uid}-source`} checked={source === "notes"} disabled={!hasNotes} onChange={() => setSource("notes")} hint={hasNotes ? "Questions come from your uploaded material" : "Upload notes to quiz yourself on them"}>
            My notes
          </Choice>
          <Choice type="radio" name={`${uid}-source`} checked={source === "document"} disabled={!hasNotes} onChange={() => setSource("document")} hint={hasNotes ? "Questions come from one of your documents only" : "Upload notes first"}>
            Specific document
          </Choice>
        </div>
        {!hasNotes && (
          <p className="mt-2 text-sm text-slate-600">
            You haven&apos;t got any processed notes yet.{" "}
            <Link to="/notes" className="font-medium text-brand-700 underline">
              Upload notes
            </Link>
          </p>
        )}
      </Group>

      {source !== "topic" ? (
        <div className="space-y-4">
          {source === "document" ? (
            <div>
              <label htmlFor={`${uid}-document`} className="text-sm font-semibold text-slate-900">
                Document
              </label>
              <select id={`${uid}-document`} value={documentId} onChange={(e) => setDocumentId(e.target.value)} className={`${field} mt-1.5`}>
                <option value="">Choose a document…</option>
                {options.notes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-600">Every question comes from this document only.</p>
            </div>
          ) : (
          <Group legend="Choose your notes" hint={`Pick up to ${QUIZ_LIMITS.maxNotes}. Only notes that finished processing are listed.`}>
            <div className="mb-2">
              <button
                type="button"
                onClick={() => setNoteIds((cur) => (cur.length > 0 ? [] : options.notes.slice(0, QUIZ_LIMITS.maxNotes).map((n) => n.id)))}
                className="rounded-lg px-3 py-2.5 text-xs font-medium text-brand-700 ring-1 ring-brand-100 hover:bg-brand-50"
              >
                {noteIds.length > 0 ? "Clear selection" : options.notes.length > QUIZ_LIMITS.maxNotes ? `Use my ${QUIZ_LIMITS.maxNotes} latest notes` : "Use all my notes"}
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.notes.map((n) => (
                <Choice key={n.id} type="checkbox" name={`${uid}-note`} checked={noteIds.includes(n.id)} disabled={!noteIds.includes(n.id) && noteIds.length >= QUIZ_LIMITS.maxNotes} onChange={() => toggleNote(n.id)} hint={`${n.pageCount ? `${n.pageCount} pages · ` : ""}${n.chunkCount} sections`}>
                  <span className="break-words">{n.title}</span>
                </Choice>
              ))}
            </div>
          </Group>
          )}
          <div>
            <label htmlFor={`${uid}-focus`} className="text-sm font-semibold text-slate-900">
              Focus on <span className="font-normal text-slate-600">(optional)</span>
            </label>
            <input id={`${uid}-focus`} value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={QUIZ_LIMITS.focusMaxChars} placeholder="e.g. entropy and the second law" className={`${field} mt-1.5`} />
            <p className="mt-1 text-xs text-slate-600">Only quiz on the parts of your material about this.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-subject`} className="text-sm font-semibold text-slate-900">
                Subject
              </label>
              <input id={`${uid}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={QUIZ_LIMITS.subjectMaxChars} placeholder="e.g. Physics" aria-invalid={touched && source === "topic" && subject.trim() === "" ? true : undefined} className={`${field} mt-1.5`} />
            </div>
            <div>
              <label htmlFor={`${uid}-topic`} className="text-sm font-semibold text-slate-900">
                Topic <span className="font-normal text-slate-600">(optional)</span>
              </label>
              <input id={`${uid}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={QUIZ_LIMITS.topicMaxChars} placeholder="e.g. Thermodynamics" className={`${field} mt-1.5`} />
            </div>
          </div>
          {options.topics.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-600">From your AI Tutor sessions</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {options.topics.map((t) => (
                  <button
                    key={`${t.subject}|${t.topic ?? ""}`}
                    type="button"
                    onClick={() => {
                      setSubject(t.subject);
                      setTopic(t.topic ?? "");
                    }}
                    className="rounded-full bg-white px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-300 hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-100"
                  >
                    {[t.subject, t.topic].filter(Boolean).join(" · ")}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Group legend="Difficulty">
        <div role="radiogroup" aria-label="Difficulty" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DIFFICULTIES.map((d) => (
            <Choice key={d} type="radio" name={`${uid}-difficulty`} checked={difficulty === d} onChange={() => setDifficulty(d)}>
              {DIFFICULTY_LABEL[d]}
            </Choice>
          ))}
        </div>
      </Group>

      <Group legend="Number of questions">
        <div role="radiogroup" aria-label="Number of questions" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {QUIZ_LIMITS.countOptions.map((n) => (
            <Choice key={n} type="radio" name={`${uid}-count`} checked={count === n} onChange={() => setCount(n)}>
              {n} questions
            </Choice>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600">A local AI writes a few questions at a time, so bigger quizzes take longer to create.</p>
      </Group>

      <Group legend="Question types" hint="Choose one or more.">
        <div className="grid gap-2 sm:grid-cols-2">
          {GENERATABLE_QUESTION_TYPES.map((t) => (
            <Choice key={t} type="checkbox" name={`${uid}-type`} checked={types.includes(t)} onChange={() => toggleType(t)}>
              {QUESTION_TYPE_LABEL[t]}
            </Choice>
          ))}
          {(["short_answer", "numerical"] as const).map((t) => (
            <Choice key={t} type="checkbox" name={`${uid}-type`} checked={false} disabled onChange={() => undefined} hint="Coming soon">
              {QUESTION_TYPE_LABEL[t]}
            </Choice>
          ))}
        </div>
      </Group>

      <div>
        <label htmlFor={`${uid}-timer`} className="text-sm font-semibold text-slate-900">
          Timer
        </label>
        <select id={`${uid}-timer`} value={timeLimit ?? ""} onChange={(e) => setTimeLimit(e.target.value === "" ? null : Number(e.target.value))} className={`${field} mt-1.5 sm:max-w-xs`}>
          {QUIZ_LIMITS.timeLimitOptions.map((m) => (
            <option key={m ?? "none"} value={m ?? ""}>
              {m === null ? "No timer" : `${m} minutes`}
            </option>
          ))}
        </select>
      </div>

      {touched && problem && <Alert tone="error">{problem}</Alert>}
      {error && (
        <Alert tone="error">
          {error}{" "}
          {busyQuizId && (
            <Link to={p.quiz(busyQuizId)} className="font-medium underline">
              See the quiz being created
            </Link>
          )}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
        <Button type="submit" loading={submitting} className="min-w-44">
          Generate quiz
        </Button>
        <Link to={p.home} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Cancel
        </Link>
      </div>
    </form>
  );
}
