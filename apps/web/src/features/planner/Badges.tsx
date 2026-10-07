import type { ActivityType, PlanStatus, SessionStatus } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";
import { ACTIVITY_INFO, PLAN_STATUS_INFO, SESSION_STATUS_INFO } from "./format";

const ICON: Partial<Record<SessionStatus, string>> = {
  completed: "M3 8.5l3.2 3L13 4.5",
  skipped: "M4 8h8",
  missed: "M8 4v5M8 11.5v.5",
  in_progress: "M6 4.5l5 3.5-5 3.5z",
  rescheduled: "M3 8h9M9 5l3 3-3 3",
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const info = SESSION_STATUS_INFO[status];
  const path = ICON[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${info.classes}`}>
      {path && (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={path} />
        </svg>
      )}
      {info.label}
    </span>
  );
}

export function ActivityBadge({ type }: { type: ActivityType }) {
  const info = ACTIVITY_INFO[type];
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${info.classes}`}>{info.label}</span>;
}

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const info = PLAN_STATUS_INFO[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${info.classes}`}>
      {status === "generating" && <Spinner className="h-3 w-3" />}
      {info.label}
    </span>
  );
}

/** LOCAL AI vs MOCK AI: a plan made by the demo provider must never look like a real one. */
export function PlanProvenance({ isMock, model }: { isMock: boolean; model: string | null }) {
  return isMock ? (
    <span title="The topics are placeholder demo text, not chosen by a real AI model." className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-amber-900">
      MOCK AI
    </span>
  ) : (
    <span title="Topics chosen by an AI model running on this computer. No paid service is used." className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-emerald-800 ring-1 ring-emerald-200">
      LOCAL AI{model ? ` · ${model}` : ""}
    </span>
  );
}
