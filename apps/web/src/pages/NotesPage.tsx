import { useMemo, useState } from "react";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/ErrorState";
import { SkeletonCard, SkeletonRegion } from "../components/ui/Skeleton";
import { ContinueBar } from "../features/continue/ContinueBar";
import { useAuth } from "../auth/AuthProvider";
import { EmptyNotes, NoMatches } from "../features/notes/EmptyNotes";
import { NoteCard } from "../features/notes/NoteCard";
import { NotesFilters } from "../features/notes/NotesFilters";
import { UploadDialog } from "../features/notes/UploadDialog";
import { DEFAULT_FILTERS, useDebounced, useNotesLibrary, type LibraryFilters } from "../features/notes/useNotesLibrary";

/** `/notes`: the student's library of study material. */
export default function NotesPage({ basePath = "/notes" }: { basePath?: string } = {}) {
  const { client } = useAuth();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
  const [uploadOpen, setUploadOpen] = useState(false);
  const q = useDebounced(search.trim(), 300);
  const effective = useMemo(() => ({ ...filters, q }), [filters, q]);
  const library = useNotesLibrary(client, effective);
  const now = useMemo(() => new Date(), [library.state]);
  const filtering = Boolean(q || filters.type || filters.status);

  const clear = () => {
    setSearch("");
    setFilters(DEFAULT_FILTERS);
  };

  return (
    <div className="animate-fade-up">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
          <p className="mt-1 text-sm text-slate-600">Your study material, ready to explain, summarise and quiz you.</p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>Upload Notes</Button>
      </header>

      <div className="mt-4 empty:hidden">
        <ContinueBar />
      </div>

      <div className="mt-6">
        <NotesFilters search={search} onSearch={setSearch} filters={filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />
      </div>

      <section aria-label="Your notes" aria-busy={library.state.status === "loading"} className="mt-5">
        {library.state.status === "loading" && (
          <SkeletonRegion label="Loading your notes…" className="space-y-3">
            <SkeletonCard lines={2} action />
            <SkeletonCard lines={2} action />
          </SkeletonRegion>
        )}
        {library.state.status === "error" && (
          <ErrorState message={library.state.message} onRetry={() => void library.reload()} />
        )}
        {library.state.status === "ready" &&
          (library.state.notes.length === 0 ? (
            filtering ? (
              <NoMatches onClear={clear} />
            ) : (
              <EmptyNotes onUpload={() => setUploadOpen(true)} />
            )
          ) : (
            <>
              <p className="sr-only" role="status">
                {library.state.notes.length} {library.state.notes.length === 1 ? "note" : "notes"} shown
              </p>
              <ul className="space-y-3">
                {library.state.notes.map((note) => (
                  <NoteCard key={note.id} note={note} now={now} basePath={basePath} onRetry={library.retry} onRemove={library.remove} />
                ))}
              </ul>
            </>
          ))}
      </section>

      {uploadOpen && <UploadDialog client={client} basePath={basePath} onClose={() => setUploadOpen(false)} onUploaded={library.upsert} />}
    </div>
  );
}
