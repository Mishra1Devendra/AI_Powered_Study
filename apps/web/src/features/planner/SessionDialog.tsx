import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { SessionAction, StudySession } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { ActivityBadge, SessionStatusBadge } from "./Badges";
import { addDays, formatLong } from "./dates";
import { PRIORITY_LABEL, formatMinutes, tutorDraft } from "./format";
import { Dialog } from "./Dialog";
import { usePlannerPaths } from "./paths";
import { StudyCheck } from "./StudyCheck";

interface Props {
  session: StudySession;
  /** The session it was moved to (when it was rescheduled). */
  movedTo: StudySession | null;
  today: string;
  examDate: string;
  /** Actions are only offered on the active plan. */
  editable: boolean;
  onAction: (action: SessionAction, body?: { date?: string }) => Promise<void>;
  /** Called after the study check was passed (the session is now completed): reload the plan. */
  onVerified: () => Promise<void>;
  onClose: () => void;
}

/** Details of one session and what can be done with it right now. */
export function SessionDialog({ session: s, movedTo, today, examDate, editable, onAction, onVerified, onClose }: Props) {
  const p = usePlannerPaths();
  const navigate = useNavigate();
  const ids = useId();
  const [busy, setBusy] = useState<SessionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** "Mark complete" opens the 5-question study check; the session is only completed by passing it. */
  const [checking, setChecking] = useState(false);
  const [date, setDate] = useState("");
  const status = s.effectiveStatus;
  const lastDay = addDays(examDate, -1);
  const canReschedule = editable && (status === "missed" || status === "skipped" || (status === "planned" && s.status === "planned"));

  async function run(action: SessionAction, body?: { date?: string }) {
    setBusy(action);
    setError(null);
    try {
      await onAction(action, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const openTutor = () => navigate(p.tutor, { state: { draft: tutorDraft(s), subject: s.subject, topic: s.topic } });

  if (checking) {
    return (
      <Dialog title="Check your understanding" onClose={onClose}>
        <StudyCheck session={s} onPassed={onVerified} onCancel={() => (s.status === "completed" ? onClose() : setChecking(false))} />
      </Dialog>
    );
  }

  return (
    <Dialog title={s.topic} onClose={onClose} busy={busy !== null}>
      <div className="flex flex-wrap items-center gap-1.5">
        <ActivityBadge type={s.activityType} />
        <SessionStatusBadge status={status} />
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-slate-600">Subject</dt>
        <dd className="font-medium text-slate-900">{s.subject}</dd>
        <dt className="text-slate-600">Date</dt>
        <dd className="text-slate-900">
          {formatLong(s.date)}
          {s.date === today && " (today)"}
        </dd>
        <dt className="text-slate-600">Time</dt>
        <dd className="text-slate-900">
          {s.startTime ? `${s.startTime} · ` : ""}
          {formatMinutes(s.durationMinutes)}
        </dd>
        <dt className="text-slate-600">Priority</dt>
        <dd className="text-slate-900">{PRIORITY_LABEL[s.priority]}</dd>
      </dl>

      {status === "missed" && s.status !== "missed" && editable && <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">This session&apos;s day has passed. Move it to a free day, or keep it as missed.</p>}
      {s.status === "rescheduled" && movedTo && <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">Moved to {formatLong(movedTo.date)}. This entry is kept as history.</p>}
      {s.rescheduledFromId && <p className="mt-4 text-xs text-slate-600">This session was rescheduled from an earlier day.</p>}

      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {picking && (
        <div className="mt-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <label htmlFor={`${ids}-date`} className="mb-1 block text-sm font-medium text-slate-800">
            New date <span className="font-normal text-slate-600">(before your exam)</span>
          </label>
          <input id={`${ids}-date`} type="date" min={today} max={lastDay} value={date} onChange={(e) => setDate(e.target.value)} className="h-11 w-full rounded-xl bg-white px-3 text-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600" />
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button onClick={() => void run("reschedule", date ? { date } : {})} loading={busy === "reschedule"} disabled={busy !== null}>
              {date ? "Move to this date" : "Find the next free day"}
            </Button>
            <Button variant="ghost" onClick={() => setPicking(false)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-600">Your daily study time is respected. The original entry is kept in your history.</p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {editable && status === "planned" && (
          <Button data-initial-focus onClick={() => void run("start")} loading={busy === "start"} disabled={busy !== null}>
            Start session
          </Button>
        )}
        {editable && (status === "planned" || status === "in_progress") && (
          <Button variant={status === "in_progress" ? "primary" : "secondary"} data-initial-focus={status === "in_progress" || undefined} onClick={() => setChecking(true)} disabled={busy !== null}>
            Mark complete
          </Button>
        )}
        {editable && (status === "planned" || status === "in_progress") && (
          <Button variant="ghost" onClick={() => void run("skip")} loading={busy === "skip"} disabled={busy !== null}>
            Skip
          </Button>
        )}
        {canReschedule && !picking && (
          <Button variant={status === "missed" ? "primary" : "secondary"} onClick={() => setPicking(true)} disabled={busy !== null}>
            Reschedule
          </Button>
        )}
        {editable && status === "missed" && s.status !== "missed" && (
          <Button variant="secondary" onClick={() => void run("miss")} loading={busy === "miss"} disabled={busy !== null}>
            Keep as missed
          </Button>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
        <Button variant="secondary" onClick={openTutor}>
          Open AI Tutor
        </Button>
        {(s.activityType === "quiz" || s.activityType === "mock_test") && (
          <Link to={p.quizCreate} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-brand-700 hover:bg-brand-50">
            Create a quiz
          </Link>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-600">Opens the AI Tutor with a suggested question. Nothing is sent until you press send.</p>
    </Dialog>
  );
}
