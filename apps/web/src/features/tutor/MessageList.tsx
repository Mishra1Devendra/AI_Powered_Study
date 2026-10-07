import { useLayoutEffect, useRef } from "react";
import type { TutorMessage } from "@copilot/shared";
import { MessageItem } from "./MessageItem";
import { StreamingMessage } from "./StreamingMessage";

interface MessageListProps {
  messages: TutorMessage[];
  /** null = not streaming; "" = waiting for the first token. */
  streamingText: string | null;
  busy: boolean;
  onRegenerate: () => void;
  /** Phase 11: ask again, from general knowledge, for the question a "not in your notes" reply was about. */
  onExplainGenerally?: ((question: string) => void) | undefined;
  notesBasePath?: string;
}

const NEAR_BOTTOM_PX = 120;

/** Scrolling transcript. Follows new content only while the student is already at the bottom. */
export function MessageList({ messages, streamingText, busy, onRegenerate, onExplainGenerally, notesBasePath }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const lastIsAssistant = messages[messages.length - 1]?.role === "assistant";

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m, i) => {
          const question = m.grounding === "not_found" && messages[i - 1]?.role === "user" ? messages[i - 1]!.content : null;
          const latest = !busy && lastIsAssistant && m.id === lastAssistantId;
          return (
            <MessageItem
              key={m.id}
              message={m}
              canRegenerate={latest}
              onRegenerate={onRegenerate}
              onExplainGenerally={latest && question && onExplainGenerally ? () => onExplainGenerally(question) : undefined}
              {...(notesBasePath ? { notesBasePath } : {})}
            />
          );
        })}
        {streamingText !== null && <StreamingMessage text={streamingText} />}
      </div>
    </div>
  );
}
