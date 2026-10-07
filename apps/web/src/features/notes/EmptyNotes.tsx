import { Button } from "../../components/ui/Button";
import { NotesIcon } from "../../components/ui/Icons";

/** First-time empty library: explains the value, offers the one action. No sample notes are shown. */
export function EmptyNotes({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-14 text-center">
      <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <NotesIcon className="h-7 w-7" />
      </span>
      <h2 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">Turn your study material into an interactive study companion.</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        Upload a PDF or paste your notes to generate summaries, explanations, flashcards and quizzes, all grounded in your own material.
      </p>
      <Button onClick={onUpload} className="mt-6">
        Upload Notes
      </Button>
      <p className="mt-3 text-xs text-slate-600">PDF, TXT and Markdown up to 10 MB. Your files are private to you.</p>
    </div>
  );
}

/** A search or filter matched nothing (the library itself is not empty). */
export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 py-12 text-center">
      <h2 className="text-base font-semibold text-slate-900">No notes match your search</h2>
      <p className="mt-1.5 text-sm text-slate-600">Try a different word, or clear the filters.</p>
      <Button variant="secondary" onClick={onClear} className="mt-4">
        Clear search and filters
      </Button>
    </div>
  );
}
