import { useEffect, useRef, useState } from "react";
import { ClockIcon } from "../../components/ui/Icons";
import { formatClock } from "./format";

/**
 * Countdown for a timed quiz. It is only a display of the SERVER's deadline. Screen readers are
 * told at a few milestones (not every second).
 */
export function TimerBadge({ remaining }: { remaining: number }) {
  const [announcement, setAnnouncement] = useState("");
  const said = useRef(new Set<number>());
  useEffect(() => {
    for (const [mark, text] of [[300, "5 minutes left"], [60, "1 minute left"], [10, "10 seconds left"]] as const) {
      if (remaining <= mark && !said.current.has(mark)) {
        said.current.add(mark);
        setAnnouncement(text);
      }
    }
  }, [remaining]);
  const urgent = remaining <= 60;
  const soon = remaining <= 300;
  return (
    <>
      <span
        role="timer"
        aria-label={`Time remaining ${formatClock(remaining)}`}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums ring-1 ${urgent ? "bg-red-50 text-red-800 ring-red-200" : soon ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-slate-100 text-slate-800 ring-slate-200"}`}
      >
        <ClockIcon className="h-4 w-4" />
        {formatClock(remaining)}
      </span>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
