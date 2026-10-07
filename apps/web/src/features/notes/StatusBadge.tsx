import type { NoteStatus } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";
import { STATUS_INFO } from "./format";

/** Status is always conveyed by text (and an icon), never by colour alone. */
export function StatusBadge({ status }: { status: NoteStatus }) {
  const info = STATUS_INFO[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${info.classes}`}>
      {info.busy ? (
        <Spinner className="h-3 w-3" />
      ) : (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {status === "ready" ? <path d="M3 8.5l3.2 3L13 4.5" /> : <path d="M4 4l8 8M12 4l-8 8" />}
        </svg>
      )}
      {info.label}
    </span>
  );
}

/** Indeterminate bar: used when the real percentage is unknown (never a fake percentage). */
export function IndeterminateBar({ label }: { label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuetext={label} className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="indeterminate-bar absolute inset-y-0 w-1/3 rounded-full bg-brand-600" />
    </div>
  );
}
