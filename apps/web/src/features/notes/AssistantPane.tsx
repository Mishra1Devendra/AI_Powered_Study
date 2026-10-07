import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ASSISTANT_ACTIONS, ASSISTANT_ACTION_INFO, NOTE_LIMITS, type AssistantAction, type AssistantInput, type SourceRef } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Composer } from "../tutor/Composer";
import { AssistantMessage, StreamingAssistantMessage } from "./AssistantMessage";
import type { useNotesAssistant } from "./useNotesAssistant";

type Assistant = ReturnType<typeof useNotesAssistant>;

interface Props {
  assistant: Assistant;
  title: string;
  /** Jump to a cited passage in the document. */
  onSource: (s: SourceRef) => void;
  onSignInAgain: () => void;
}

const NEAR_BOTTOM_PX = 120;
const BUTTON_ACTIONS = ASSISTANT_ACTIONS.filter((a): a is Exclude<AssistantAction, "ask"> => a !== "ask");

/** The AI study assistant for one document: one-tap study actions + free questions, all grounded in the document. */
export function AssistantPane({ assistant, title, onSource, onSignInAgain }: Props) {
  const { messages, streamingText, phase, error, loadError, isBusy } = assistant;
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loading = phase === "loading";
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const lastIsAssistant = messages[messages.length - 1]?.role === "assistant";

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  const run = useCallback(
    (request: AssistantInput) => {
      stick.current = true;
      void assistant.send(request);
    },
    [assistant],
  );

  const ask = () => {
    const question = input.trim();
    if (!question) return;
    run({ action: "ask", question });
    setInput("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-base font-semibold tracking-tight text-slate-900">Study assistant</h2>
        <p className="truncate text-xs text-slate-600">Answers come from “{title}”</p>
      </div>

      <div
        ref={scroller}
        role="log"
        aria-label="Assistant conversation"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
      >
        {loading ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">Loading conversation</span>
            <div className="ml-auto h-8 w-1/2 animate-pulse rounded-2xl bg-slate-100" />
            <div className="h-20 w-4/5 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : loadError ? (
          <div className="space-y-3">
            <Alert tone="error">{loadError}</Alert>
            <Button variant="secondary" onClick={() => void assistant.reload()}>
              Try again
            </Button>
          </div>
        ) : messages.length === 0 && streamingText === null ? (
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-800">Pick a study action, or ask a question.</p>
            <p className="mt-1">I only answer from this document. If it doesn’t cover something, I’ll say so rather than guess.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {messages.map((m, i) => (
              <AssistantMessage
                key={m.id}
                message={m}
                canRegenerate={!isBusy && lastIsAssistant && m.id === lastAssistantId}
                onRegenerate={() => void assistant.regenerate()}
                onSource={onSource}
                question={m.grounding === "not_found" && messages[i - 1]?.role === "user" ? messages[i - 1]!.content : null}
              />
            ))}
            {streamingText !== null && <StreamingAssistantMessage text={streamingText} />}
          </div>
        )}
      </div>

      <div className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-3 pb-3 pt-3">
        {error && (
          <Alert tone={error.code === "stopped" ? "info" : "error"}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{error.message}</span>
              <span className="flex gap-2">
                {error.reauth ? (
                  <button type="button" className="font-medium underline" onClick={onSignInAgain}>
                    Sign in again
                  </button>
                ) : (
                  error.retryable && (
                    <button type="button" className="font-medium underline" onClick={() => void assistant.retry()}>
                      Retry
                    </button>
                  )
                )}
                <button type="button" className="font-medium underline" onClick={assistant.dismissError}>
                  Dismiss
                </button>
              </span>
            </div>
          </Alert>
        )}
        <div role="group" aria-label="Study actions" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
          {BUTTON_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              disabled={isBusy || loading}
              title={ASSISTANT_ACTION_INFO[action].hint}
              onClick={() => run({ action })}
              className="h-9 shrink-0 whitespace-nowrap rounded-full bg-white px-3.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ASSISTANT_ACTION_INFO[action].label}
            </button>
          ))}
        </div>
        <Composer
          value={input}
          onChange={setInput}
          onSend={ask}
          onStop={assistant.stop}
          busy={isBusy}
          armedMode={null}
          onClearMode={() => undefined}
          inputRef={inputRef}
          label="Ask a question about this document"
          placeholder="Ask a question about this document..."
          maxChars={NOTE_LIMITS.questionMaxChars}
        />
      </div>
    </div>
  );
}
