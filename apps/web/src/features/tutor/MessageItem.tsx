import { memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { TUTOR_MODE_INFO, type SourceRef, type TutorMessage } from "@copilot/shared";
import { CheckIcon, SparkIcon } from "../../components/ui/Icons";
import { copyText } from "./clipboard";
import { RichText } from "./RichText";

export function TutorAvatar({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-full brand-chip shadow-sm ${className}`}>
      <SparkIcon className="h-4 w-4" />
    </span>
  );
}

const actionClass =
  "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50";

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={actionClass}
      onClick={async () => {
        setState((await copyText(text)) ? "copied" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" && <CheckIcon className="h-4 w-4 text-emerald-600" />}
      <span role="status">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

/** What a source is called: only real metadata - the document's name, and its page or section when it has one. */
export function sourceLabel(s: SourceRef): string {
  const where = s.page !== null ? `Page ${s.page}` : s.heading ? `Section: ${s.heading}` : null;
  return [s.documentTitle, where].filter(Boolean).join(" \u2013 ") || `Source ${s.key}`;
}

/** "Sources" under an answer grounded in the student's own documents. Links open the document. */
export function TutorSources({ sources, notesBasePath }: { sources: SourceRef[]; notesBasePath: string }) {
  // One chip per distinct place; the model's S1/S2 labels are for its text, not for the student.
  const unique = sources.filter((s, i) => sources.findIndex((o) => sourceLabel(o) === sourceLabel(s) && o.documentId === s.documentId) === i);
  if (unique.length === 0) return null;
  return (
    <div className="mt-2.5">
      <p className="text-xs font-medium text-slate-600">Sources from your notes</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {unique.map((s) => (
          <li key={`${s.documentId ?? ""}:${s.chunkIndex}`} className="min-w-0 max-w-full">
            {s.documentId ? (
              <Link to={`${notesBasePath}/${s.documentId}`} className="inline-block max-w-full truncate sm:max-w-72 rounded-lg bg-slate-50 px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200 hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-100" title={sourceLabel(s)}>
                {sourceLabel(s)}
              </Link>
            ) : (
              <span className="inline-block max-w-full truncate sm:max-w-72 rounded-lg bg-slate-50 px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200">{sourceLabel(s)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface MessageItemProps {
  message: TutorMessage;
  /** Show "Regenerate" (only on the latest assistant reply, when not busy). */
  canRegenerate: boolean;
  onRegenerate: () => void;
  /** Phase 11: "Explain generally" after "not in your notes". Shown only on the latest such reply. */
  onExplainGenerally?: (() => void) | undefined;
  notesBasePath?: string;
}

/** Memoised: a streaming token never re-renders the earlier messages. */
export const MessageItem = memo(function MessageItem({ message, canRegenerate, onRegenerate, onExplainGenerally, notesBasePath = "/notes" }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <article aria-label="You said" className="flex flex-col items-end gap-1">
        {message.mode && (
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">{TUTOR_MODE_INFO[message.mode].label}</span>
        )}
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm sm:max-w-[80%]">
          {message.content}
        </div>
      </article>
    );
  }
  return (
    <article aria-label="Tutor replied" className="flex gap-3">
      <TutorAvatar className="mt-0.5 h-8 w-8" />
      <div className="min-w-0 flex-1">
        {message.isMock && (
          <p className="mb-1.5 inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">
            Demo response - not from a real AI model
          </p>
        )}
        {message.grounding === "grounded" && (
          <p className="mb-1.5 inline-block rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">From your notes</p>
        )}
        {message.grounding === "general" && (
          <p className="mb-1.5 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">General explanation - not from your notes</p>
        )}
        <div className="rounded-2xl rounded-tl-md bg-slate-50 px-4 py-3 text-[15px] leading-relaxed text-slate-800 ring-1 ring-slate-200/70">
          <RichText text={message.content} />
        </div>
        <TutorSources sources={message.sources ?? []} notesBasePath={notesBasePath} />
        <div className="-ml-2 mt-1.5 flex items-center gap-1">
          <CopyButton text={message.content} />
          {message.grounding === "not_found" && onExplainGenerally && (
            <button type="button" className={`${actionClass} text-brand-700`} onClick={onExplainGenerally}>
              Explain generally
            </button>
          )}
          {canRegenerate && message.grounding !== "not_found" && (
            <button type="button" className={actionClass} onClick={onRegenerate}>
              Regenerate
            </button>
          )}
        </div>
      </div>
    </article>
  );
});
