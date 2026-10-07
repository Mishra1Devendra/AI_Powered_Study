import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  KNOWLEDGE_LEVELS,
  PLANNER_LIMITS,
  PREFERRED_TIMES,
  PRIORITIES,
  WEEKDAY_SHORT,
  planInputSchema,
  type KnowledgeLevel,
  type PlanInput,
  type PlanOptions,
  type PreferredTime,
  type Priority,
} from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { addDays } from "./dates";
import { LEVEL_LABEL, PRIORITY_LABEL, TIME_LABEL, formatMinutes } from "./format";
import { usePlannerPaths } from "./paths";

interface Props {
  options: PlanOptions;
  /** Settings to start from (e.g. "use the settings of a previous plan"). */
  initial?: Partial<PlanInput> | undefined;
  /** Starts creating the plan. Rejects with a student-readable message. */
  onSubmit: (input: PlanInput) => Promise<void>;
  error?: string | null;
  /** A plan the server says is already being created, so we can link to it. */
  busyPlanId?: string | null;
}

interface SubjectRow {
  key: number;
  name: string;
  priority: Priority;
  topics: string;
}

const field = "h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600";
const LEVEL_HINT: Record<KnowledgeLevel, string> = { beginner: "Start from the basics", intermediate: "I know the basics", advanced: "Mostly practice and revision" };

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
function Choice({ type, name, checked, onChange, children, hint }: { type: "radio" | "checkbox"; name: string; checked: boolean; onChange: () => void; children: ReactNode; hint?: string }) {
  return (
    <label
      className={`relative flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-600 ${
        checked ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
      }`}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} className="sr-only" />
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

let nextKey = 1;
const row = (name = "", priority: Priority = "medium", topics = ""): SubjectRow => ({ key: nextKey++, name, priority, topics });
const splitTopics = (s: string) =>
  s
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

export function CreatePlanForm({ options, initial, onSubmit, error, busyPlanId }: Props) {
  const p = usePlannerPaths();
  const ids = useId();
  const tomorrow = addDays(options.today, 1);
  const lastDay = addDays(options.today, PLANNER_LIMITS.maxPlanDays);
  const startMinutes = initial?.minutesPerDay ?? 60;

  const [title, setTitle] = useState(initial?.title ?? "");
  const [examDate, setExamDate] = useState(initial?.examDate && initial.examDate > options.today ? initial.examDate : "");
  const [target, setTarget] = useState(initial?.targetScore != null ? String(initial.targetScore) : "");
  const [minutesChoice, setMinutesChoice] = useState<number | "custom">((PLANNER_LIMITS.minutesOptions as readonly number[]).includes(startMinutes) ? startMinutes : "custom");
  const [customMinutes, setCustomMinutes] = useState(String(startMinutes));
  const [level, setLevel] = useState<KnowledgeLevel>(initial?.knowledgeLevel ?? "intermediate");
  const [subjects, setSubjects] = useState<SubjectRow[]>(() => (initial?.subjects?.length ? initial.subjects.map((s) => row(s.name, s.priority, s.topics.join(", "))) : [row()]));
  const [days, setDays] = useState<number[]>(initial?.studyDays ?? [1, 2, 3, 4, 5]);
  const [time, setTime] = useState<PreferredTime>(initial?.preferredTime ?? "any");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // State updates are not visible until the next render, so a fast double click needs a synchronous guard.
  const inFlight = useRef(false);

  const minutesPerDay = minutesChoice === "custom" ? Number(customMinutes) : minutesChoice;
  const update = (key: number, patch: Partial<SubjectRow>) => setSubjects((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const toggleDay = (d: number) => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setLocalError(null);
    const candidate = {
      title,
      examDate,
      targetScore: target.trim() === "" ? null : Number(target),
      minutesPerDay,
      knowledgeLevel: level,
      subjects: subjects.filter((s) => s.name.trim() || s.topics.trim()).map((s) => ({ name: s.name, priority: s.priority, topics: splitTopics(s.topics) })),
      studyDays: days,
      preferredTime: time,
    };
    if (!examDate) return setLocalError("Choose your exam date.");
    if (examDate <= options.today) return setLocalError("The exam date must be after today.");
    if (examDate > lastDay) return setLocalError(`The exam date must be within ${PLANNER_LIMITS.maxPlanDays} days.`);
    if (candidate.subjects.some((s) => s.topics.length > PLANNER_LIMITS.maxTopicsPerSubject)) return setLocalError(`At most ${PLANNER_LIMITS.maxTopicsPerSubject} topics per subject.`);
    const parsed = planInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setLocalError(issue?.path[0] === "targetScore" ? "Target score must be a whole number from 0 to 100." : (issue?.message ?? "Please check the form."));
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const shown = localError ?? error ?? null;

  return (
    <form onSubmit={submit} noValidate className="space-y-7">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`${ids}-title`} className="mb-1.5 block text-sm font-semibold text-slate-900">
            Plan name
          </label>
          <input id={`${ids}-title`} className={field} value={title} maxLength={PLANNER_LIMITS.titleMaxChars} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Class 12 board exams" />
        </div>
        <div>
          <label htmlFor={`${ids}-exam`} className="mb-1.5 block text-sm font-semibold text-slate-900">
            Exam date
          </label>
          <input id={`${ids}-exam`} type="date" className={field} value={examDate} min={tomorrow} max={lastDay} onChange={(e) => setExamDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${ids}-target`} className="mb-1.5 block text-sm font-semibold text-slate-900">
            Target score <span className="font-normal text-slate-600">(optional, %)</span>
          </label>
          <input id={`${ids}-target`} type="number" inputMode="numeric" min={0} max={100} step={1} className={field} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 85" />
        </div>
      </div>

      <Group legend="Study time per day">
        <div className="flex flex-wrap gap-2 whitespace-nowrap [&>label]:flex-1 [&>label]:basis-28">
          {PLANNER_LIMITS.minutesOptions.map((m) => (
            <Choice key={m} type="radio" name="minutes" checked={minutesChoice === m} onChange={() => setMinutesChoice(m)}>
              {formatMinutes(m)}
            </Choice>
          ))}
          <Choice type="radio" name="minutes" checked={minutesChoice === "custom"} onChange={() => setMinutesChoice("custom")}>
            Custom
          </Choice>
        </div>
        {minutesChoice === "custom" && (
          <div className="mt-2.5 max-w-48">
            <label htmlFor={`${ids}-custom`} className="mb-1 block text-xs font-medium text-slate-700">
              Minutes per day ({PLANNER_LIMITS.minMinutesPerDay}–{PLANNER_LIMITS.maxMinutesPerDay})
            </label>
            <input id={`${ids}-custom`} type="number" inputMode="numeric" min={PLANNER_LIMITS.minMinutesPerDay} max={PLANNER_LIMITS.maxMinutesPerDay} step={5} className={field} value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} />
          </div>
        )}
      </Group>

      <Group legend="Your current level">
        <div className="grid gap-2 sm:grid-cols-3">
          {KNOWLEDGE_LEVELS.map((l) => (
            <Choice key={l} type="radio" name="level" checked={level === l} onChange={() => setLevel(l)} hint={LEVEL_HINT[l]}>
              {LEVEL_LABEL[l]}
            </Choice>
          ))}
        </div>
      </Group>

      <Group legend="Subjects" hint="Add each subject with its priority. Topics are optional: list any you must cover, separated by commas.">
        <datalist id={`${ids}-suggest`}>
          {options.subjects.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <ul className="space-y-3">
          {subjects.map((s, i) => (
            <li key={s.key} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${ids}-s${s.key}`} className="sr-only">
                    Subject {i + 1} name
                  </label>
                  <input id={`${ids}-s${s.key}`} list={`${ids}-suggest`} className={field} value={s.name} maxLength={PLANNER_LIMITS.subjectMaxChars} onChange={(e) => update(s.key, { name: e.target.value })} placeholder={`Subject ${i + 1}, e.g. Physics`} />
                </div>
                <div className="flex gap-2">
                  <label htmlFor={`${ids}-p${s.key}`} className="sr-only">
                    Subject {i + 1} priority
                  </label>
                  <select id={`${ids}-p${s.key}`} className={`${field} sm:w-40`} value={s.priority} onChange={(e) => update(s.key, { priority: e.target.value as Priority })}>
                    {PRIORITIES.map((pr) => (
                      <option key={pr} value={pr}>
                        {PRIORITY_LABEL[pr]} priority
                      </option>
                    ))}
                  </select>
                  {subjects.length > 1 && (
                    <button type="button" onClick={() => setSubjects((list) => list.filter((x) => x.key !== s.key))} aria-label={`Remove subject ${i + 1}${s.name ? ` (${s.name})` : ""}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 ring-1 ring-slate-300 hover:bg-white">
                      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <label htmlFor={`${ids}-t${s.key}`} className="sr-only">
                Subject {i + 1} topics (optional)
              </label>
              <input id={`${ids}-t${s.key}`} className={`${field} mt-2`} value={s.topics} onChange={(e) => update(s.key, { topics: e.target.value })} placeholder="Topics (optional), e.g. Kinematics, Laws of motion" />
            </li>
          ))}
        </ul>
        {subjects.length < PLANNER_LIMITS.maxSubjects && (
          <Button type="button" variant="secondary" className="mt-3" onClick={() => setSubjects((list) => [...list, row()])}>
            + Add subject
          </Button>
        )}
      </Group>

      <Group legend="Study days" hint="No sessions are planned on other days or on the exam day itself.">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {WEEKDAY_SHORT.map((label, i) => (
            <Choice key={label} type="checkbox" name="days" checked={days.includes(i + 1)} onChange={() => toggleDay(i + 1)}>
              {label}
            </Choice>
          ))}
        </div>
      </Group>

      <Group legend="Preferred study time">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PREFERRED_TIMES.map((t) => (
            <Choice key={t} type="radio" name="time" checked={time === t} onChange={() => setTime(t)}>
              {TIME_LABEL[t]}
            </Choice>
          ))}
        </div>
      </Group>

      {options.weakTopics.length > 0 && (
        <p className="rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-900">
          From your quiz results, these topics need more practice and will be scheduled early when they match your subjects: <strong>{options.weakTopics.map((w) => w.topic).join(", ")}</strong>.
        </p>
      )}

      {shown && (
        <Alert tone="error">
          {shown}
          {busyPlanId && (
            <>
              {" "}
              <Link to={p.plan(busyPlanId)} className="font-semibold underline">
                See the plan being created
              </Link>
            </>
          )}
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-600">One request to your local AI. Nothing is sent to a paid service.</p>
        <Button type="submit" loading={submitting} className="w-full sm:w-auto">
          {submitting ? "Starting…" : "Generate plan"}
        </Button>
      </div>
    </form>
  );
}
