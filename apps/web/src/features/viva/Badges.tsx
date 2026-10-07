import { scoreLevel, SCORE_LEVEL_LABEL, VIVA_DIFFICULTY_LABEL, VIVA_STATUS_LABEL, type VivaDifficulty, type VivaStatus } from "@copilot/shared";
import { LEVEL_STYLE } from "./format";

/** The level is always written out with the percentage ("Weak — 42%") and an icon, never colour alone. */
export function ScoreBadge({ score }: { score: number }) {
  const level = scoreLevel(score);
  const s = LEVEL_STYLE[level];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${s.badge}`}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={s.icon} />
      </svg>
      {SCORE_LEVEL_LABEL[level]} — {Math.round(score)}%
    </span>
  );
}

export function Meter({ value, label }: { value: number; label: string }) {
  const level = scoreLevel(value);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-valuetext={`${SCORE_LEVEL_LABEL[level]}, ${Math.round(value)}%`} className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, value))}%`, backgroundColor: LEVEL_STYLE[level].bar }} />
    </div>
  );
}

/** A viva written by the offline demo provider must never look like a real examiner. */
export function ProvenanceBadge({ isMock, model }: { isMock: boolean; model: string | null }) {
  return isMock ? (
    <span title="Questions and feedback are canned demo text from the offline provider, not a real AI examiner." className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-amber-900">
      MOCK AI (demo)
    </span>
  ) : (
    <span title="Written by an AI model running on this computer. No paid service is used." className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-emerald-800 ring-1 ring-emerald-200">
      LOCAL AI{model ? ` · ${model}` : ""}
    </span>
  );
}

/** Where the examiner's questions come from. Only for a viva based on the student's own notes. */
export function SourceBadge({ sourceType, documentTitle }: { sourceType?: "general" | "notes" | "document" | undefined; documentTitle?: string | null | undefined }) {
  if (!sourceType || sourceType === "general") return null;
  return (
    <span className="inline-flex max-w-full items-center truncate rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
      Based on: {sourceType === "document" ? (documentTitle ?? "one document") : "your notes"}
    </span>
  );
}

export const DifficultyBadge = ({ d }: { d: VivaDifficulty }) => <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{VIVA_DIFFICULTY_LABEL[d]}</span>;

const STATUS_STYLE: Record<VivaStatus, string> = { in_progress: "bg-brand-50 text-brand-800 ring-brand-200", completed: "bg-emerald-50 text-emerald-800 ring-emerald-200", abandoned: "bg-slate-100 text-slate-700 ring-slate-200" };
export const StatusBadge = ({ status }: { status: VivaStatus }) => <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${STATUS_STYLE[status]}`}>{VIVA_STATUS_LABEL[status]}</span>;
