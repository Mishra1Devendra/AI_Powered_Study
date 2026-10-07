import { useState } from "react";
import { Link } from "react-router";
import type { Note } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { NotesIcon } from "../../components/ui/Icons";
import { relativeTime } from "../dashboard/format";
import { FILE_TYPE_LABEL, formatBytes, formatDate, isBusy, noteStats } from "./format";
import { AskAiLink, QuizFromNoteLink } from "./AskAiLink";
import { IndexChecklist } from "./IndexChecklist";
import { IndeterminateBar, StatusBadge } from "./StatusBadge";

interface NoteCardProps {
  note: Note;
  now: Date;
  basePath: string;
  onRetry: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

const actionButton =
  "inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

export function NoteCard({ note, now, basePath, onRetry, onRemove }: NoteCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"retry" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = note.status === "ready";
  const meta = [FILE_TYPE_LABEL[note.fileType], formatBytes(note.fileSize), noteStats(note)].filter(Boolean).join(" · ");

  async function run(kind: "retry" | "remove", fn: () => Promise<void>) {
    setPending(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setPending(null);
      setConfirming(false);
    }
  }

  return (
    <li className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:ring-brand-500/30 sm:p-5">
      <div className="flex items-start gap-4">
        <span aria-hidden="true" className="mt-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 sm:flex">
          <NotesIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <h3 className="min-w-0 text-base font-semibold tracking-tight text-slate-900">
              {ready ? (
                <Link to={`${basePath}/${note.id}`} className="break-words rounded hover:text-brand-700 hover:underline">
                  {note.title}
                </Link>
              ) : (
                <span className="break-words">{note.title}</span>
              )}
            </h3>
            <StatusBadge status={note.status} />
          </div>
          <p className="mt-1 text-sm text-slate-600">{meta}</p>
          <p className="mt-0.5 text-sm text-slate-600">
            Added {formatDate(note.createdAt)}
            {ready && <> · Last activity {relativeTime(note.lastActivityAt, now).toLowerCase()}</>}
            {note.source === "upload" && <span className="hidden sm:inline"> · {note.originalFilename}</span>}
          </p>

          {isBusy(note) && (
            <div className="mt-3 max-w-sm">
              <IndeterminateBar label={note.status === "uploading" ? "Uploading" : "Processing"} />
              <p className="mt-1.5 text-xs text-slate-600">{note.status === "uploading" ? "Uploading your file…" : "Reading and organising your material…"}</p>
            </div>
          )}
          {ready && (
            <div className="mt-2">
              <IndexChecklist note={note} compact />
            </div>
          )}
          {note.status === "failed" && <p className="mt-3 text-sm font-medium text-slate-800">We couldn’t prepare this document.</p>}
          {note.status === "failed" && note.error && (
            <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {note.error}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {ready && (
              <Link to={`${basePath}/${note.id}`} className={`${actionButton} bg-brand-600 text-white hover:bg-brand-700`}>
                Open
              </Link>
            )}
            {ready && <AskAiLink note={note} basePath={basePath} className={`${actionButton} text-brand-700 ring-1 ring-brand-100 hover:bg-brand-50`} />}
            {ready && <QuizFromNoteLink note={note} basePath={basePath} className={`${actionButton} text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50`} />}
            {note.status === "failed" && (
              <Button variant="secondary" className="h-9 px-3" loading={pending === "retry"} onClick={() => void run("retry", () => onRetry(note.id))}>
                Retry processing
              </Button>
            )}
            {confirming ? (
              <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-900">
                Remove from your library?
                <button type="button" className={`${actionButton} h-8 bg-red-700 text-white hover:bg-red-800`} disabled={pending === "remove"} onClick={() => void run("remove", () => onRemove(note.id))}>
                  Remove
                </button>
                <button type="button" className={`${actionButton} h-8 text-slate-700 hover:bg-white`} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" aria-label={`Remove ${note.title} from library`} className={`${actionButton} text-slate-600 hover:bg-slate-100 hover:text-red-700`} onClick={() => setConfirming(true)}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
