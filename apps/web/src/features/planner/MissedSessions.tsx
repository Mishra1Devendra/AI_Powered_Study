import { useState } from "react";
import type { SessionAction, StudySession } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { ActivityBadge } from "./Badges";
import { formatMedium } from "./dates";
import { formatMinutes } from "./format";

interface Props {
  /** Sessions whose day passed without being finished, and that the student has not decided about yet. */
  sessions: StudySession[];
  onAction: (sessionId: string, action: SessionAction) => Promise<void>;
}

/** Missed sessions: move each to the next free day before the exam, or keep it as missed. */
export function MissedSessions({ sessions, onAction }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  async function run(id: string, action: SessionAction) {
    setBusy(`${id}:${action}`);
    setError(null);
    try {
      await onAction(id, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="missed-heading" className="rounded-(--radius-card) bg-amber-50/70 p-4 ring-1 ring-amber-200 sm:p-5">
      <h2 id="missed-heading" className="text-base font-semibold text-amber-950">
        {sessions.length === 1 ? "1 missed session" : `${sessions.length} missed sessions`}
      </h2>
      <p className="mt-0.5 text-sm text-amber-900">Reschedule moves a session to the next day with free time before your exam. The original stays in your history.</p>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <ul className="mt-3 space-y-2">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 rounded-xl bg-white p-3 ring-1 ring-amber-200 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <ActivityBadge type={s.activityType} />
                <span className="break-words text-sm font-medium text-slate-900">{s.topic}</span>
              </div>
              <p className="text-xs text-slate-600">
                {s.subject} · {formatMedium(s.date)} · {formatMinutes(s.durationMinutes)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button className="h-10 px-4" onClick={() => void run(s.id, "reschedule")} loading={busy === `${s.id}:reschedule`} disabled={busy !== null} aria-label={`Reschedule ${s.topic}`}>
                Reschedule
              </Button>
              <Button variant="secondary" className="h-10 px-4" onClick={() => void run(s.id, "miss")} loading={busy === `${s.id}:miss`} disabled={busy !== null} aria-label={`Keep ${s.topic} as missed`}>
                Keep as missed
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
