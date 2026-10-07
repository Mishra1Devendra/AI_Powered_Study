import { NOTE_FILE_TYPES, noteStatusSchema } from "@copilot/shared";
import { FILE_TYPE_LABEL, STATUS_INFO } from "./format";
import type { LibraryFilters } from "./useNotesLibrary";

interface Props {
  /** The search box value (shown immediately; the query itself is debounced by the parent). */
  search: string;
  onSearch: (value: string) => void;
  filters: LibraryFilters;
  onChange: (patch: Partial<LibraryFilters>) => void;
}

const control =
  "h-11 rounded-xl bg-white px-3 text-sm text-slate-800 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600";

export function NotesFilters({ search, onSearch, filters, onChange }: Props) {
  return (
    <div role="search" aria-label="Search and filter notes" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative min-w-0 flex-1 sm:min-w-64">
        <label htmlFor="notes-search" className="sr-only">
          Search notes by title or file name
        </label>
        <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4 4" />
        </svg>
        <input
          id="notes-search"
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by title or file name"
          maxLength={100}
          className={`${control} w-full pl-10 placeholder:text-slate-500`}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <span className="sr-only sm:not-sr-only">Type</span>
        <select aria-label="Filter by file type" value={filters.type} onChange={(e) => onChange({ type: e.target.value as LibraryFilters["type"] })} className={control}>
          <option value="">All types</option>
          {NOTE_FILE_TYPES.map((t) => (
            <option key={t} value={t}>
              {FILE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <span className="sr-only sm:not-sr-only">Status</span>
        <select aria-label="Filter by status" value={filters.status} onChange={(e) => onChange({ status: e.target.value as LibraryFilters["status"] })} className={control}>
          <option value="">Any status</option>
          {noteStatusSchema.options.map((s) => (
            <option key={s} value={s}>
              {STATUS_INFO[s].label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <span className="sr-only sm:not-sr-only">Sort</span>
        <select aria-label="Sort notes" value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as LibraryFilters["sort"] })} className={control}>
          <option value="recent">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="activity">Recently used</option>
          <option value="name">Name (A-Z)</option>
        </select>
      </label>
    </div>
  );
}
