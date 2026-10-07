import { useState } from "react";
import type { Note } from "@copilot/shared";
import { relativeTime } from "../dashboard/format";
import { FILE_TYPE_LABEL, formatBytes, formatDate, noteStats } from "./format";
import { AskAiLink } from "./AskAiLink";
import { IndexChecklist } from "./IndexChecklist";
import { StatusBadge } from "./StatusBadge";

type Outline = { chunkIndex: number; heading: string; page: number | null }[];

interface Props {
  note: Note;
  outline: Outline;
  activeChunk: number | null;
  onJump: (chunkIndex: number) => void;
  basePath?: string;
}

const MAX_COLLAPSED = 40;

/** Document details + an outline built from the headings found in the file. */
export function InfoPane({ note, outline, activeChunk, onJump, basePath = "/notes" }: Props) {
  const [showAll, setShowAll] = useState(false);
  const items = showAll ? outline : outline.slice(0, MAX_COLLAPSED);
  const rows: [string, string][] = [
    ["Type", FILE_TYPE_LABEL[note.fileType]],
    ["Size", formatBytes(note.fileSize)],
    ["Length", noteStats(note) || "-"],
    ["Added", formatDate(note.createdAt)],
    ["Last activity", relativeTime(note.lastActivityAt, new Date())],
  ];
  return (
    <div className="h-full overflow-y-auto overscroll-contain px-4 py-4">
      <h2 className="break-words text-base font-semibold tracking-tight text-slate-900">{note.title}</h2>
      <div className="mt-2">
        <StatusBadge status={note.status} />
      </div>
      <div className="mt-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
        <IndexChecklist note={note} />
        {note.status === "ready" && (
          <div className="mt-3">
            <AskAiLink note={note} basePath={basePath} className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700" />
          </div>
        )}
      </div>
      <dl className="mt-4 space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-slate-600">{k}</dt>
            <dd className="text-right font-medium text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-6 text-sm font-semibold text-slate-900">Outline</h3>
      {outline.length === 0 ? (
        <p className="mt-1.5 text-sm text-slate-600">No headings were found in this file.</p>
      ) : (
        <nav aria-label="Document outline" className="mt-1.5">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={`${item.chunkIndex}-${item.heading}`}>
                <button
                  type="button"
                  onClick={() => onJump(item.chunkIndex)}
                  aria-current={activeChunk === item.chunkIndex ? "location" : undefined}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${activeChunk === item.chunkIndex ? "bg-brand-50 font-medium text-brand-700" : "text-slate-700"}`}
                >
                  <span className="min-w-0 break-words">{item.heading}</span>
                  {item.page !== null && <span className="shrink-0 text-xs text-slate-600">p. {item.page}</span>}
                </button>
              </li>
            ))}
          </ul>
          {outline.length > MAX_COLLAPSED && (
            <button type="button" className="mt-2 text-sm font-medium text-brand-700 underline" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${outline.length} headings`}
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
