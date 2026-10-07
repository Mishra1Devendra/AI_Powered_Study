import { useId, useState, type FormEvent } from "react";
import { TUTOR_LIMITS, tutorLevelSchema, type TutorContextInput, type TutorLevel } from "@copilot/shared";

interface ContextBarProps {
  subject: string | null;
  topic: string | null;
  level: TutorLevel | null;
  disabled: boolean;
  onSave: (ctx: TutorContextInput) => void;
}

const LEVEL_LABEL: Record<TutorLevel, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };

const field =
  "block h-10 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600";

/** Optional subject / topic / level. Never required: the tutor works without any of it. */
export function ContextBar({ subject, topic, level, disabled, onSave }: ContextBarProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = [subject, topic, level ? LEVEL_LABEL[level] : null].filter(Boolean).join(" · ");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const rawLevel = String(form.get("level") ?? "");
    const parsedLevel = tutorLevelSchema.safeParse(rawLevel);
    onSave({
      subject: String(form.get("subject") ?? "").trim() || null,
      topic: String(form.get("topic") ?? "").trim() || null,
      level: parsedLevel.success ? parsedLevel.data : null,
    });
    setOpen(false);
  }

  return (
    <div className="border-b border-slate-100 px-4 py-2 sm:px-5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg py-1 text-left text-sm text-slate-600 hover:text-slate-900"
      >
        <span className="truncate">
          <span className="font-medium text-slate-700">Context:</span> {summary || "Add a subject, topic or level (optional)"}
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs">
          {open ? "Hide" : "Edit"}
        </span>
      </button>
      {open && (
        // Keyed on the saved values so the fields reset when switching conversations.
        <form key={`${subject}|${topic}|${level}`} id={panelId} onSubmit={submit} className="mt-2 grid gap-3 pb-2 sm:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">
            Subject
            <input name="subject" defaultValue={subject ?? ""} maxLength={TUTOR_LIMITS.subjectMaxChars} placeholder="e.g. Physics" className={`mt-1 ${field}`} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Topic
            <input name="topic" defaultValue={topic ?? ""} maxLength={TUTOR_LIMITS.topicMaxChars} placeholder="e.g. Thermodynamics" className={`mt-1 ${field}`} />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Level
            <select name="level" defaultValue={level ?? ""} className={`mt-1 ${field}`}>
              <option value="">Not set</option>
              {tutorLevelSchema.options.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABEL[l]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 sm:col-span-3">
            <button type="submit" disabled={disabled} className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              Save context
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
