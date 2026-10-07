import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { NOTE_ACCEPT_EXTENSIONS, NOTE_LIMITS, type Note } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { ApiError } from "../../lib/api";
import { uploadFile, uploadText, type UploadProgress } from "../../lib/notesApi";
import { formatBytes, validateClientFile } from "./format";
import { IndeterminateBar } from "./StatusBadge";

type Tab = "file" | "paste";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string; progress: UploadProgress | null }
  | { kind: "error"; message: string; existingId?: string };

interface Props {
  client: SupabaseClient;
  basePath: string;
  onClose: () => void;
  onUploaded: (note: Note) => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Upload dialog: drop zone / file picker, or pasted text. Progress is real; once bytes are sent it turns indeterminate. */
export function UploadDialog({ client, basePath, onClose, onUploaded }: Props) {
  const [tab, setTab] = useState<Tab>("file");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const abort = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const titleId = useId();
  const busy = phase.kind === "uploading";

  // Focus moves in on open and back to the opener on close.
  useEffect(() => {
    const previous = opener.current as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      abort.current?.abort();
      previous?.focus?.();
    };
  }, []);

  const close = useCallback(() => {
    abort.current?.abort();
    onClose();
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    // Keep keyboard focus inside the dialog.
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (err instanceof ApiError) {
      const existing = typeof err.body?.noteId === "string" ? err.body.noteId : undefined;
      setPhase({ kind: "error", message: err.message, ...(existing ? { existingId: existing } : {}) });
      return;
    }
    setPhase({ kind: "error", message: "Something went wrong while uploading. Please try again." });
  }

  async function startFile(file: File) {
    const problem = validateClientFile(file);
    if (problem) return setPhase({ kind: "error", message: problem });
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "uploading", fileName: file.name, progress: null });
    try {
      const note = await uploadFile(client, file, {
        signal: controller.signal,
        onProgress: (progress) => setPhase({ kind: "uploading", fileName: file.name, progress }),
      });
      onUploaded(note);
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  async function submitText() {
    if (!text.trim()) return setPhase({ kind: "error", message: "Paste some text first." });
    if (text.length > NOTE_LIMITS.maxPastedChars) return setPhase({ kind: "error", message: `Pasted text can be at most ${NOTE_LIMITS.maxPastedChars.toLocaleString("en-US")} characters.` });
    setPhase({ kind: "uploading", fileName: title.trim() || "Pasted notes", progress: null });
    try {
      const note = await uploadText(client, { text, ...(title.trim() ? { title: title.trim() } : {}) });
      onUploaded(note);
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const files = e.dataTransfer.files;
    if (files.length > 1) return setPhase({ kind: "error", message: "Please upload one file at a time." });
    const file = files[0];
    if (file) void startFile(file);
  }

  const pct = phase.kind === "uploading" && phase.progress ? Math.min(100, Math.round((phase.progress.loaded / phase.progress.total) * 100)) : null;
  const sentAll = phase.kind === "uploading" && phase.progress !== null && phase.progress.loaded >= phase.progress.total;

  // Portalled to <body>: the page content is animated (transformed), which would otherwise become
  // the containing block of this "fixed" overlay and stop it covering the whole screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900">
            Add study material
          </h2>
          <button type="button" onClick={close} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100">
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          <div role="tablist" aria-label="How to add material" className="mb-4 inline-flex rounded-xl bg-slate-100 p-1">
            {(["file", "paste"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                id={`upload-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`upload-panel-${t}`}
                disabled={busy}
                onClick={() => {
                  setTab(t);
                  setPhase({ kind: "idle" });
                }}
                className={`h-9 rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed ${tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {t === "file" ? "Upload a file" : "Paste text"}
              </button>
            ))}
          </div>

          {tab === "file" ? (
            <div id="upload-panel-file" role="tabpanel" aria-labelledby="upload-tab-file">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!busy) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                data-testid="drop-zone"
                className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-5 py-9 text-center transition ${dragging ? "border-brand-600 bg-brand-50" : "border-slate-300 bg-slate-50"}`}
              >
                <p className="text-sm font-medium text-slate-800">Drag a file here, or</p>
                <input
                  ref={fileInput}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose a file"
                  accept={NOTE_ACCEPT_EXTENSIONS.join(",")}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // so choosing the same file again still fires
                    if (file) void startFile(file);
                  }}
                />
                <Button variant="secondary" className="mt-3" disabled={busy} onClick={() => fileInput.current?.click()}>
                  Choose file
                </Button>
                <p className="mt-3 text-xs text-slate-600">PDF, TXT or Markdown · up to {NOTE_LIMITS.maxFileBytes / (1024 * 1024)} MB</p>
              </div>
            </div>
          ) : (
            <div id="upload-panel-paste" role="tabpanel" aria-labelledby="upload-tab-paste" className="space-y-3">
              <div>
                <label htmlFor="paste-title" className="block text-sm font-medium text-slate-700">
                  Title <span className="font-normal text-slate-600">(optional)</span>
                </label>
                <input
                  id="paste-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={NOTE_LIMITS.titleMaxChars}
                  disabled={busy}
                  className="mt-1 h-11 w-full rounded-xl px-3 text-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
              </div>
              <div>
                <label htmlFor="paste-text" className="block text-sm font-medium text-slate-700">
                  Your notes
                </label>
                <textarea
                  id="paste-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={9}
                  disabled={busy}
                  placeholder="Paste text from your notes, slides or textbook"
                  className="mt-1 w-full resize-y rounded-xl px-3 py-2.5 text-sm ring-1 ring-slate-300 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
                <p className={`mt-1 text-xs ${text.length > NOTE_LIMITS.maxPastedChars ? "text-red-700" : "text-slate-600"}`}>
                  {text.length.toLocaleString("en-US")} / {NOTE_LIMITS.maxPastedChars.toLocaleString("en-US")} characters
                </p>
              </div>
              <Button onClick={() => void submitText()} disabled={busy || !text.trim()}>
                Add to library
              </Button>
            </div>
          )}

          {phase.kind === "uploading" && (
            <div className="mt-4 rounded-xl bg-slate-50 p-4" role="status" aria-live="polite">
              <p className="truncate text-sm font-medium text-slate-800">{phase.fileName}</p>
              {pct !== null && !sentAll ? (
                <>
                  <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-slate-600">
                    Uploading… {pct}%{phase.progress ? ` (${formatBytes(phase.progress.loaded)} of ${formatBytes(phase.progress.total)})` : ""}
                  </p>
                </>
              ) : (
                <>
                  <div className="mt-2">
                    <IndeterminateBar label={sentAll ? "Processing" : "Working"} />
                  </div>
                  <p className="mt-1.5 text-xs text-slate-600">{sentAll || tab === "paste" ? "Reading and organising your material…" : "Starting upload…"}</p>
                </>
              )}
              <button type="button" onClick={close} className="mt-3 text-sm font-medium text-slate-700 underline hover:text-slate-900">
                Cancel
              </button>
            </div>
          )}

          {phase.kind === "error" && (
            <div role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200">
              <p>{phase.message}</p>
              {phase.existingId && (
                <Link to={`${basePath}/${phase.existingId}`} onClick={onClose} className="mt-1.5 inline-block font-medium underline">
                  Open the existing note
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
