/** The app's emblem (a vector, /icons/mark.svg, sharp at any size) next to its name. `iconOnly` keeps the name for screen readers and hides it visually. */
export function Logo({ className = "", iconOnly = false, compact = false }: { className?: string; iconOnly?: boolean; /** Keep only the emblem on very small screens (the name stays for screen readers). */ compact?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight text-slate-900 ${className}`}>
      <img src="/icons/mark.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-full shadow-sm ring-1 ring-black/5" />
      <span className={`whitespace-nowrap ${iconOnly ? "sr-only" : compact ? "sr-only sm:not-sr-only" : ""}`}>Student Copilot</span>
    </span>
  );
}
