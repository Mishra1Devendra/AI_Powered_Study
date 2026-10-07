import { Button } from "./Button";

export const PAGE_SIZE = 20;

export const pageCount = (total: number, size = PAGE_SIZE) => Math.max(1, Math.ceil(total / size));

/** The rows of one page (1-based). A page past the end is clamped to the last one. */
export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): T[] {
  const p = Math.min(Math.max(1, page), pageCount(items.length, size));
  return items.slice((p - 1) * size, p * size);
}

/** "Showing 21-40 of 87". */
export function rangeText(page: number, total: number, size = PAGE_SIZE): string {
  if (total === 0) return "No rows";
  const p = Math.min(Math.max(1, page), pageCount(total, size));
  return `Showing ${(p - 1) * size + 1}–${Math.min(p * size, total)} of ${total}`;
}

/**
 * Previous / Next with "Page n of N". Renders nothing when everything fits on one page.
 * The parent owns the page number and must reset it to 1 whenever its filters change.
 */
export function Pagination({ page, total, onPage, size = PAGE_SIZE, label = "Pagination", compact = false }: { page: number; total: number; onPage: (page: number) => void; size?: number; label?: string; compact?: boolean }) {
  const pages = pageCount(total, size);
  if (total <= size) return null;
  const p = Math.min(Math.max(1, page), pages);
  return (
    <nav aria-label={label} className={`flex flex-wrap items-center justify-between gap-3 ${compact ? "px-3 py-2" : "border-t border-slate-100 px-4 py-3"}`}>
      <p className="text-xs text-slate-600" aria-live="polite">
        {rangeText(p, total, size)}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" className="h-9 px-3.5" disabled={p <= 1} onClick={() => onPage(p - 1)} aria-label={`${label}: previous page`}>
          Previous
        </Button>
        <span className="min-w-20 text-center text-sm text-slate-700">
          Page {p} of {pages}
        </span>
        <Button variant="secondary" className="h-9 px-3.5" disabled={p >= pages} onClick={() => onPage(p + 1)} aria-label={`${label}: next page`}>
          Next
        </Button>
      </div>
    </nav>
  );
}
