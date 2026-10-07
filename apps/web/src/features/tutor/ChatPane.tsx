import { useCallback, useRef, useState } from "react";
import { TUTOR_MODE_INFO, type Conversation, type TutorContextInput, type TutorMode } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Composer } from "./Composer";
import { ContextBar } from "./ContextBar";
import { EmptyTutor } from "./EmptyTutor";
import { MessageList } from "./MessageList";
import { TutorAvatar } from "./MessageItem";
import { ModeBar } from "./ModeBar";
import type { ChatError } from "./useTutorChat";
import type { TutorMessage } from "@copilot/shared";

export interface ChatPaneProps {
  conversation: Conversation | null;
  draftContext: TutorContextInput;
  messages: TutorMessage[];
  streamingText: string | null;
  isBusy: boolean;
  isLoading: boolean;
  error: ChatError | null;
  loadError: string | null;
  /** True when replies come from the demo/mock provider (no API key configured). */
  mockMode: boolean;
  /** Text to start the message box with (e.g. a quiz question the student wants explained). */
  initialDraft?: string;
  /** Phase 11: the document the student is asking about, if any. */
  documentScope?: { id: string; title: string } | null;
  onClearDocument?: () => void;
  notesBasePath?: string;
  onSend: (content: string, mode: TutorMode | null, opts?: { general?: boolean }) => void;
  onStop: () => void;
  onRetry: () => void;
  onRegenerate: () => void;
  onDismissError: () => void;
  onSetContext: (ctx: TutorContextInput) => void;
  onNew: () => void;
  onReloadConversation: () => void;
  onSignInAgain: () => void;
  onOpenHistory: () => void;
}

export function ChatPane(props: ChatPaneProps) {
  const { conversation, draftContext, messages, streamingText, isBusy, isLoading, error, loadError, mockMode } = props;
  const [input, setInput] = useState(props.initialDraft ?? "");
  const [armed, setArmed] = useState<TutorMode | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const subject = conversation ? conversation.subject : (draftContext.subject ?? null);
  const topic = conversation ? conversation.topic : (draftContext.topic ?? null);
  const level = conversation ? conversation.level : (draftContext.level ?? null);
  const hasContext = messages.length > 0 || Boolean(subject || topic);
  const showEmpty = !conversation && messages.length === 0 && streamingText === null && !loadError;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const send = useCallback(
    (content: string, mode: TutorMode | null) => {
      props.onSend(content, mode);
      setInput("");
      setArmed(null);
    },
    [props],
  );

  function onMode(mode: TutorMode) {
    if (isBusy) return;
    const text = input.trim();
    if (text) return send(text, mode); // act on what the student typed
    if (hasContext) return send(TUTOR_MODE_INFO[mode].defaultMessage, mode); // act on the conversation so far
    setArmed((current) => (current === mode ? null : mode)); // nothing to act on yet: arm for the next message
    focusInput();
  }

  function onPickStarter(text: string) {
    setInput(text);
    focusInput();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={props.onOpenHistory}
          aria-label="Open conversation history"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 lg:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
          </svg>
        </button>
        <TutorAvatar className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight text-slate-900">{conversation?.title ?? "AI Tutor"}</h1>
          <p className="truncate text-xs text-slate-500">Understand, practise, check, improve</p>
        </div>
        {mockMode && (
          <span
            title="The server is set to the demo (mock) AI, so replies are canned, not real tutoring."
            className="hidden shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 xl:inline"
          >
            Demo AI (mock)
          </span>
        )}
        <Button variant="secondary" onClick={props.onNew} className="h-10 shrink-0 px-3.5 text-sm">
          <span aria-hidden="true">+</span>
          <span className="hidden xl:inline">New conversation</span>
          <span className="sr-only xl:hidden">New conversation</span>
        </Button>
      </header>

      {mockMode && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 xl:hidden">
          Demo AI (mock): replies are not from a real model.
        </p>
      )}

      <ContextBar
        subject={subject}
        topic={topic}
        level={level}
        disabled={isBusy}
        onSave={(ctx) => {
          props.onSetContext(ctx);
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading ? (
          <div role="status" aria-busy="true" className="flex-1 space-y-4 px-6 py-6">
            <span className="sr-only">Loading conversation</span>
            <div className="ml-auto h-10 w-2/3 animate-pulse rounded-2xl bg-slate-100" />
            <div className="h-24 w-4/5 animate-pulse rounded-2xl bg-slate-100" />
          </div>
        ) : loadError ? (
          <div className="mx-auto flex flex-1 max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
            <Alert tone="error">{loadError}</Alert>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={props.onReloadConversation}>
                Try again
              </Button>
              <Button onClick={props.onNew}>Start a new conversation</Button>
            </div>
          </div>
        ) : showEmpty ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyTutor onPick={onPickStarter} />
          </div>
        ) : (
          <MessageList
            messages={messages}
            streamingText={streamingText}
            busy={isBusy}
            onRegenerate={props.onRegenerate}
            onExplainGenerally={(question) => props.onSend(question, null, { general: true })}
            {...(props.notesBasePath ? { notesBasePath: props.notesBasePath } : {})}
          />
        )}
      </div>

      {props.documentScope && (
        <div className="flex items-center justify-between gap-3 border-t border-brand-100 bg-brand-50 px-4 py-2 text-sm text-brand-800 sm:px-5">
          <p className="min-w-0 truncate">
            <span className="font-medium">Asking about:</span> {props.documentScope.title}
          </p>
          {props.onClearDocument && (
            <button type="button" onClick={props.onClearDocument} disabled={isBusy} className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium hover:bg-brand-100 disabled:opacity-50">
              Ask about all my notes
            </button>
          )}
        </div>
      )}

      <div className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-3 pb-3 pt-3 sm:px-5">
        {error && (
          <div className="mx-auto max-w-3xl">
            <Alert tone={error.code === "stopped" ? "info" : "error"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{error.message}</span>
                <span className="flex gap-2">
                  {error.reauth ? (
                    <button type="button" className="font-medium underline" onClick={props.onSignInAgain}>
                      Sign in again
                    </button>
                  ) : (
                    error.retryable && (
                      <button type="button" className="font-medium underline" onClick={props.onRetry}>
                        Retry
                      </button>
                    )
                  )}
                  <button type="button" className="font-medium underline" onClick={props.onDismissError}>
                    Dismiss
                  </button>
                </span>
              </div>
            </Alert>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-2.5">
          <ModeBar armed={armed} disabled={isBusy || isLoading} onSelect={onMode} />
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => send(input.trim(), armed)}
            onStop={props.onStop}
            busy={isBusy}
            armedMode={armed}
            onClearMode={() => setArmed(null)}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  );
}
