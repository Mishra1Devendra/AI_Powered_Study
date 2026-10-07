import { Link } from "react-router";
import type { Note } from "@copilot/shared";

/** Opens the AI Tutor limited to ONE document. The tutor is the existing screen; nothing is asked until the student sends a message. */
export function tutorPathFor(basePath: string): string {
  // The notes screens and the tutor sit side by side under the same prefix ("" in the app, the preview prefix in the DEV preview).
  return basePath.endsWith("/notes") ? `${basePath.slice(0, -"notes".length)}tutor` : "/tutor";
}

/** Where "Make a quiz" goes: the existing quiz form, with this document already chosen. Nothing is generated until Generate is pressed. */
export function quizPathFor(basePath: string, documentId: string): string {
  const base = basePath.endsWith("/notes") ? `${basePath.slice(0, -"notes".length)}quiz/new` : "/quiz/new";
  return `${base}?document=${encodeURIComponent(documentId)}`;
}

export function QuizFromNoteLink({ note, basePath, className }: { note: Pick<Note, "id" | "title">; basePath: string; className?: string }) {
  return (
    <Link
      to={quizPathFor(basePath, note.id)}
      aria-label={`Make a quiz from ${note.title}`}
      className={className ?? "inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-50"}
    >
      Make a Quiz
    </Link>
  );
}

export function AskAiLink({ note, basePath, className }: { note: Pick<Note, "id" | "title">; basePath: string; className?: string }) {
  return (
    <Link
      to={tutorPathFor(basePath)}
      state={{ documentId: note.id, documentTitle: note.title }}
      aria-label={`Ask AI about ${note.title}`}
      className={className ?? "inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-white transition hover:bg-brand-700"}
    >
      Ask AI About This
    </Link>
  );
}

/** Where "Make flashcards" / "Make a mind map" go: the creation panel of that tool, with this note already chosen. Nothing is generated until the button there is pressed. */
export function studyToolPathFor(basePath: string, tool: "flashcards" | "mindmaps", documentId: string): string {
  const root = basePath.endsWith("/notes") ? basePath.slice(0, -"notes".length) : "/";
  return `${root}${tool}?document=${encodeURIComponent(documentId)}`;
}

export function StudyToolLinks({ note, basePath }: { note: Pick<Note, "id" | "title">; basePath: string }) {
  const cls = "inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-50";
  return (
    <>
      <Link to={studyToolPathFor(basePath, "flashcards", note.id)} aria-label={`Make flashcards from ${note.title}`} className={cls}>
        Make Flashcards
      </Link>
      <Link to={studyToolPathFor(basePath, "mindmaps", note.id)} aria-label={`Make a mind map from ${note.title}`} className={cls}>
        Make a Mind map
      </Link>
    </>
  );
}
