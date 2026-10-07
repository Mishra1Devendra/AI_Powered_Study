import { useId, useState, type FormEvent } from "react";
import { PLANNER_LIMITS, type StudyPlan, type UpdatePlanInput } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { addDays } from "./dates";
import { Dialog } from "./Dialog";

interface Props {
  plan: StudyPlan;
  today: string;
  onSave: (patch: UpdatePlanInput) => Promise<void>;
  onClose: () => void;
}

const field = "h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600";

/** Basic edits: name, exam date and daily study time. Existing sessions are not rewritten. */
export function EditPlanDialog({ plan, today, onSave, onClose }: Props) {
  const ids = useId();
  const [title, setTitle] = useState(plan.title);
  const [examDate, setExamDate] = useState(plan.examDate);
  const [minutes, setMinutes] = useState(String(plan.minutesPerDay));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const patch: UpdatePlanInput = {};
    const m = Number(minutes);
    if (title.trim() !== plan.title) patch.title = title.trim();
    if (examDate !== plan.examDate) patch.examDate = examDate;
    if (m !== plan.minutesPerDay) patch.minutesPerDay = m;
    if (Object.keys(patch).length === 0) return onClose();
    if (patch.title !== undefined && !patch.title) return setError("Give your plan a name.");
    if (patch.examDate !== undefined && patch.examDate <= today) return setError("The exam date must be after today.");
    if (patch.minutesPerDay !== undefined && (!Number.isInteger(m) || m < PLANNER_LIMITS.minMinutesPerDay || m > PLANNER_LIMITS.maxMinutesPerDay)) {
      return setError(`Study time must be a whole number from ${PLANNER_LIMITS.minMinutesPerDay} to ${PLANNER_LIMITS.maxMinutesPerDay} minutes.`);
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Edit plan" onClose={onClose} busy={saving}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <label htmlFor={`${ids}-t`} className="mb-1.5 block text-sm font-medium text-slate-800">
            Plan name
          </label>
          <input id={`${ids}-t`} className={field} value={title} maxLength={PLANNER_LIMITS.titleMaxChars} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${ids}-d`} className="mb-1.5 block text-sm font-medium text-slate-800">
            Exam date
          </label>
          <input id={`${ids}-d`} type="date" className={field} min={addDays(today, 1)} max={addDays(today, PLANNER_LIMITS.maxPlanDays)} value={examDate} onChange={(e) => setExamDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${ids}-m`} className="mb-1.5 block text-sm font-medium text-slate-800">
            Study time per day (minutes)
          </label>
          <input id={`${ids}-m`} type="number" inputMode="numeric" step={5} min={PLANNER_LIMITS.minMinutesPerDay} max={PLANNER_LIMITS.maxMinutesPerDay} className={field} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
        <p className="text-xs text-slate-600">Changes apply to rescheduling from now on; sessions already planned stay as they are. To rebuild the timetable, regenerate the plan.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
