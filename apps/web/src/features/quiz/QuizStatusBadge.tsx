import type { QuizStatus } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";
import { QUIZ_STATUS_INFO } from "./format";

/** Status is always conveyed by text and an icon, never by colour alone. */
export function QuizStatusBadge({ status }: { status: QuizStatus }) {
  const info = QUIZ_STATUS_INFO[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${info.classes}`}>
      {status === "generating" ? (
        <Spinner className="h-3 w-3" />
      ) : (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {status === "ready" ? <path d="M3 8.5l3.2 3L13 4.5" /> : <path d="M4 4l8 8M12 4l-8 8" />}
        </svg>
      )}
      {info.label}
    </span>
  );
}

/** Identifies Gemini-generated quizzes or clearly labels retained demo records. */
export function QuizProvenance({ isMock, model }: { isMock: boolean; model: string | null }) {
  return isMock ? (
    <span title="These questions are canned demo text, not written by a real AI model." className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-amber-900">
      MOCK AI
    </span>
  ) : (
    <span title={model === "free-online-ai" ? "Written online by Google Gemini. Your prompt and relevant study content may be sent to Google." : "Written by the configured AI model."} className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-emerald-800 ring-1 ring-emerald-200">
      {model === "free-online-ai" ? "Google Gemini (online)" : `AI${model ? ` · ${model}` : ""}`}
    </span>
  );
}
