import { BUG_SEVERITY_LABEL, BUG_STATUS_LABEL, BUG_TYPE_LABEL, type BugReport, type BugStatus } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../planner/Dialog";

const STATUSES: BugStatus[] = ["open", "in_progress", "resolved"];
const TYPE_CHIP = { bug: "bg-red-600 text-white", feature: "bg-violet-600 text-white", other: "bg-slate-600 text-white" } as const;
const SEVERITY_TEXT = { low: "text-slate-700", medium: "text-amber-700", high: "text-red-700" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

/** One report in full: everything the reporter wrote, who and when, and the three status buttons. Opens when a card is clicked. */
export function BugDetailDialog({ report, busy, onMove, onClose }: { report: BugReport; busy: boolean; onMove: (status: BugStatus) => void; onClose: () => void }) {
  return (
    <Dialog title={report.title} onClose={onClose} busy={busy}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <span className={`rounded px-2 py-0.5 ${TYPE_CHIP[report.type]}`}>{BUG_TYPE_LABEL[report.type]}</span>
        <span className={`font-mono ${SEVERITY_TEXT[report.severity]}`}>{BUG_SEVERITY_LABEL[report.severity]} severity</span>
        {report.page && <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono font-normal normal-case tracking-normal text-slate-700">{report.page}</span>}
      </div>

      <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{report.description}</p>

      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-slate-600">Reported by</dt>
        <dd className="font-medium text-slate-900">{report.reporterName ?? "Unknown"}</dd>
        <dt className="text-slate-600">Reported</dt>
        <dd className="text-slate-900">{when(report.createdAt)}</dd>
        <dt className="text-slate-600">Status</dt>
        <dd className="font-medium text-slate-900">{BUG_STATUS_LABEL[report.status]}</dd>
        {report.status === "resolved" && (
          <>
            <dt className="text-slate-600">Resolved</dt>
            <dd className="text-slate-900">{when(report.resolvedAt)}</dd>
          </>
        )}
      </dl>

      <div role="group" aria-label="Move this report" className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <span className="mr-1 text-sm text-slate-600">Move to</span>
        {STATUSES.map((s) => (
          <Button key={s} variant={report.status === s ? "primary" : "secondary"} className="h-9 px-3.5" disabled={busy || report.status === s} aria-pressed={report.status === s} onClick={() => onMove(s)}>
            {BUG_STATUS_LABEL[s]}
          </Button>
        ))}
        <Button variant="ghost" className="ml-auto h-9 px-3.5" onClick={onClose} disabled={busy}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
