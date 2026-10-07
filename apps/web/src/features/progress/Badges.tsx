import { MASTERY_LABEL, type MasteryLevel } from "@copilot/shared";
import { LEVEL_STYLE } from "./format";

/** The label is always written out, with an icon: the colour is only a reinforcement. */
export function LevelBadge({ level }: { level: MasteryLevel }) {
  const s = LEVEL_STYLE[level];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${s.badge}`}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={s.icon} />
      </svg>
      {MASTERY_LABEL[level]}
    </span>
  );
}

/** A horizontal bar whose value is also written as text next to it. */
export function Meter({ value, level, label }: { value: number; level: MasteryLevel; label: string }) {
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)}%`} className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, Math.min(100, value))}%`, backgroundColor: LEVEL_STYLE[level].bar }} />
    </div>
  );
}
