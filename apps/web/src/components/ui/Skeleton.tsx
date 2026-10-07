import type { ReactNode } from "react";

/** One placeholder block. Quiet on purpose: a gentle pulse (switched off for reduced-motion users by the global rule). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-lg bg-slate-200/70 ${className}`} />;
}

/** Wraps placeholders so assistive technology hears ONE "loading" message instead of a page of empty boxes. */
export function SkeletonRegion({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

/** A card-shaped placeholder: title line, a few text lines, optional action. */
export function SkeletonCard({ lines = 3, action = false, className = "" }: { lines?: number; action?: boolean; className?: string }) {
  return (
    <div aria-hidden="true" className={`rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6 ${className}`}>
      <Skeleton className="h-5 w-1/3" />
      <SkeletonText lines={lines} className="mt-5" />
      {action && <Skeleton className="mt-5 h-10 w-32 rounded-xl" />}
    </div>
  );
}

/** A list of rows with an avatar-ish block and two lines each. */
export function SkeletonList({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return (
    <ul aria-hidden="true" className={`divide-y divide-slate-100 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-3.5">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A table-shaped placeholder: a header row and `rows` body rows of `cols` cells. */
export function SkeletonTable({ rows = 4, cols = 4, className = "" }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`space-y-3 ${className}`}>
      <div className="flex gap-4">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
