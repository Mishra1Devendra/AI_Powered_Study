interface ProgressBarProps {
  value: number;
  label: string;
  color?: string;
  className?: string;
}

/** Thin accessible progress bar. `value` is 0-100. */
export function ProgressBar({ value, label, color = "var(--color-brand-600)", className = "" }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 ${className}`}
    >
      <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}
