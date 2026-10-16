import { memo } from "react";
import { Link, useLocation } from "react-router";
import { ASSISTANT_ACTION_INFO, assistantActionSchema, type SourceRef, type TutorMessage } from "@copilot/shared";
import { CopyButton, TutorAvatar } from "../tutor/MessageItem";
import { RichText } from "../tutor/RichText";

/** Identifies Gemini-generated content or clearly labels retained demo records. */
export function Provenance({ isMock, model }: { isMock: boolean; model: string | null }) {
  return isMock ? (
    <span title="This answer is canned demo text, not from a real AI model." className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-amber-900">
      MOCK AI
    </span>
  ) : (
    <span title={model === "free-online-ai" ? "Answered online by Google Gemini. Your prompt and relevant study content may be sent to Google." : "Answered by the configured AI model."} className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-emerald-800 ring-1 ring-emerald-200">
      {model === "free-online-ai" ? "Google Gemini (online)" : `AI${model ? ` · ${model}` : ""}`}
    </span>
  );
}

const actionClass =
  "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50";

/** "Sources used": chips built from the server's real chunk metadata (page / section), never from model text. */
export function SourceChips({ sources, onSource }: { sources: SourceRef[]; onSource: (s: SourceRef) => void }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-2.5">
      <p className="text-xs font-medium text-slate-600">Sources used</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => onSource(s)}
              className="max-w-56 truncate rounded-lg bg-slate-50 px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200 hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-100"
              aria-label={`Source ${s.key}${s.page !== null ? `, page ${s.page}` : ""}${s.heading ? `, ${s.heading}` : ""}`}
              title={s.heading ?? undefined}
            >
              <span className="font-semibold">{s.key}</span>
              {s.page !== null && <span> · p. {s.page}</span>}
              {s.heading && <span> · {s.heading}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  message: TutorMessage;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onSource: (s: SourceRef) => void;
  /** The question a "not in your notes" reply was about, so the student can ask it generally in the AI Tutor. */
  question?: string | null;
}

export const AssistantMessage = memo(function AssistantMessage({ message, canRegenerate, onRegenerate, onSource, question }: Props) {
  const { pathname } = useLocation();
  const tutorPath = `${pathname.startsWith("/dev/") ? pathname.slice(0, 4) : ""}/tutor`;
  if (message.role === "user") {
    const action = assistantActionSchema.safeParse(message.action);
    return (
      <article aria-label="You asked" className="flex flex-col items-end gap-1">
        {action.success && action.data !== "ask" && (
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">{ASSISTANT_ACTION_INFO[action.data].label}</span>
        )}
        <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm leading-relaxed text-white">{message.content}</div>
      </article>
    );
  }
  const sources = message.sources ?? [];
  return (
    <article aria-label="Assistant replied" className="flex gap-2.5">
      <TutorAvatar className="mt-0.5 h-7 w-7" />
      <div className="min-w-0 flex-1">
        <Provenance isMock={message.isMock} model={message.model} />
        <div className="mt-1.5 text-sm leading-relaxed text-slate-800">
          <RichText text={message.content} sources={sources} onSource={onSource} />
        </div>
        <SourceChips sources={sources} onSource={onSource} />
        <div className="-ml-2 mt-1 flex items-center gap-1">
          <CopyButton text={message.content} />
          {message.grounding === "not_found" && question && (
            <Link to={tutorPath} state={{ draft: question }} className={`${actionClass} text-brand-700`}>
              Explain generally in the AI Tutor
            </Link>
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

/** The reply being written right now (citations become links once the answer is complete). */
export function StreamingAssistantMessage({ text }: { text: string }) {
  return (
    <article aria-label="Assistant is replying" aria-busy="true" className="flex gap-2.5">
      <TutorAvatar className="mt-0.5 h-7 w-7" />
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-slate-800">
        {text === "" ? (
          <div role="status" className="flex h-7 items-center gap-1.5">
            <span className="sr-only">The assistant is reading your notes</span>
            {[0, 1, 2].map((i) => (
              <span key={i} aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-slate-400" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
            <span aria-hidden="true" className="ml-1 text-xs text-slate-600">Reading your notes…</span>
          </div>
        ) : (
          <RichText text={text} />
        )}
      </div>
    </article>
  );
}
