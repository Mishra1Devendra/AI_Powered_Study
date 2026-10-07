import { useEffect, useId, type KeyboardEvent, type RefObject } from "react";
import { TUTOR_LIMITS, TUTOR_MODE_INFO, type TutorMode } from "@copilot/shared";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  armedMode: TutorMode | null;
  onClearMode: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Accessible name of the box (default: tutor wording). */
  label?: string;
  /** Placeholder when no mode is armed. */
  placeholder?: string;
  /** Character cap (default: the tutor's message limit). */
  maxChars?: number;
}

const MAX_HEIGHT_PX = 192;

export function Composer({ value, onChange, onSend, onStop, busy, armedMode, onClearMode, inputRef, label = "Message your tutor", placeholder: basePlaceholder = "Ask your tutor anything...", maxChars = TUTOR_LIMITS.messageMaxChars }: ComposerProps) {
  const id = useId();
  const length = value.trim().length;
  const tooLong = value.length > maxChars;
  const canSend = !busy && length > 0 && !tooLong;
  const showCounter = value.length >= maxChars * 0.8;

  // Auto-grow up to a cap, then scroll.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value, inputRef]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline. Ignore Enter while an IME is composing text.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  const placeholder = armedMode
    ? `${TUTOR_MODE_INFO[armedMode].label}: ${TUTOR_MODE_INFO[armedMode].hint.toLowerCase()}. Type your message...`
    : basePlaceholder;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      className="rounded-2xl bg-white p-2 shadow-card ring-1 ring-slate-300 transition duration-200 focus-within:shadow-[0_0_0_4px_rgb(99_102_241/0.12)] focus-within:ring-2 focus-within:ring-brand-600"
    >
      {armedMode && (
        <div className="mb-1.5 flex items-center gap-2 px-2 pt-1">
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Mode: {TUTOR_MODE_INFO[armedMode].label}</span>
          <button type="button" onClick={onClearMode} className="rounded text-xs font-medium text-slate-600 underline hover:text-slate-900">
            Clear
          </button>
        </div>
      )}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-invalid={tooLong || undefined}
          aria-describedby={`${id}-help`}
          className="max-h-48 min-h-11 w-full resize-none bg-transparent px-2 py-2.5 text-[15px] leading-relaxed text-slate-900 placeholder:text-slate-500 focus:outline-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="h-11 shrink-0 rounded-full bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-brand-600 dark:hover:bg-brand-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            className="h-11 shrink-0 rounded-full bg-brand-600 px-5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 disabled:shadow-none"
          >
            Send
          </button>
        )}
      </div>
      <p id={`${id}-help`} aria-live="polite" className="flex justify-between gap-3 px-2 pt-1 text-xs text-slate-500">
        <span className="hidden sm:inline">Enter to send, Shift+Enter for a new line</span>
        {showCounter && (
          <span className={tooLong ? "font-medium text-red-700" : ""}>
            {tooLong
              ? `Too long: ${value.length}/${maxChars} characters`
              : `${value.length}/${maxChars}`}
          </span>
        )}
      </p>
    </form>
  );
}
