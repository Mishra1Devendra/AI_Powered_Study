import type { Conversation, TutorMessage, TutorStreamEvent } from "@copilot/shared";
import { ConflictError } from "../errors.js";
import { AIError, type LLMProvider } from "../services/ai/index.js";
import type { ChatMessage } from "../services/ai/types.js";

/** A prepared generation: the student's message is saved; `events()` streams the reply. */
export interface Turn {
  /** Streams events; persists the assistant message on success. Never throws for provider errors. */
  events(signal: AbortSignal): AsyncGenerator<TutorStreamEvent, void, void>;
  /** Releases the per-conversation lock. Idempotent; the route calls it in `finally`. */
  release(): void;
}

/** Replies longer than this are treated as malformed provider output. */
const MAX_REPLY_CHARS = 60_000;
export const DEFAULT_REPLY_DEADLINE_MS = 120_000;

/** Prevents two replies being generated for the same conversation at once (single API instance). */
export function createGenerationLock(busyMessage: string) {
  const generating = new Set<string>();
  return function acquire(id: string): () => void {
    if (generating.has(id)) throw new ConflictError(busyMessage);
    generating.add(id);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        generating.delete(id);
      }
    };
  };
}

export type TurnPrompt = { system: string; messages: ChatMessage[] } | { fixed: string };

/** Saved as the model of replies the server wrote itself (no AI involved). */
export const FIXED_REPLY_MODEL = "knowledge-index";

export interface TurnOptions {
  ai: LLMProvider;
  replyDeadlineMs: number;
  onError?: ((err: unknown) => void) | undefined;
  /** Sent first, e.g. the saved student message. */
  leadingEvent: TutorStreamEvent | null;
  release: () => void;
  /**
   * Builds the model request. Runs inside the turn, so retrieval errors become error events.
   * Phase 11: may return `{ fixed }` instead - a reply the server already knows ("not in your notes"). No model is
   * called for it, and it is saved with the model name `knowledge-index` so it is never mistaken for AI output.
   */
  buildPrompt: () => Promise<TurnPrompt> | TurnPrompt;
  /** Persists the finished reply and returns what the client needs. */
  save: (reply: { content: string; model: string; isMock: boolean }) => Promise<{ message: TutorMessage; conversation: Conversation }>;
}

const errorEvent = (code: string, message: string, retryable: boolean): TutorStreamEvent => ({
  type: "error",
  code,
  message,
  retryable,
});

/**
 * The single place that turns "a prompt" into "a streamed, validated, persisted reply".
 * Used by both the AI Tutor and the AI Notes assistant. Provider failures, timeouts, empty or
 * malformed replies become typed error events; a client disconnect stops quietly.
 * There is exactly one provider call per turn and no automatic retry.
 */
export function createTurn(opts: TurnOptions): Turn {
  const { ai, replyDeadlineMs, onError, leadingEvent, release, buildPrompt, save } = opts;

  async function* events(signal: AbortSignal): AsyncGenerator<TutorStreamEvent, void, void> {
    if (leadingEvent) yield leadingEvent;

    const deadline = AbortSignal.timeout(replyDeadlineMs);
    const combined = AbortSignal.any([signal, deadline]);
    let text = "";
    let produced: { model: string; isMock: boolean } = { model: ai.model, isMock: ai.isMock };
    try {
      const prompt = await buildPrompt();
      if ("fixed" in prompt) {
        text = prompt.fixed;
        produced = { model: FIXED_REPLY_MODEL, isMock: false };
        yield { type: "delta", text };
      } else {
        const stream = ai.streamText({ system: prompt.system, messages: prompt.messages, signal: combined });
        while (true) {
          const next = await stream.next();
          if (next.done) {
            produced = next.value.produced ?? produced;
            break;
          }
          text += next.value;
          if (text.length > MAX_REPLY_CHARS) throw new AIError("unknown", "The AI returned an unusually long response.", true); // a runaway answer may well be fine on another try
          yield { type: "delta", text: next.value };
        }
      }
      if (text.trim() === "") throw new AIError("empty_response", "The AI returned an empty response.", true);

      const { message, conversation } = await save({ content: text.trim(), model: produced.model, isMock: produced.isMock });
      yield { type: "done", message, conversation };
    } catch (err) {
      if (signal.aborted) return; // client went away: nothing to report, the student's message stays saved
      if (deadline.aborted) {
        yield errorEvent("timeout", "The AI took too long to respond.", true);
      } else if (err instanceof AIError) {
        yield errorEvent(err.code, err.message, err.retryable);
      } else if (err instanceof Error && "status" in err && "code" in err && typeof (err as { status: unknown }).status === "number") {
        // An AppError raised during prompt building (e.g. the note is no longer available).
        yield errorEvent((err as { code: string }).code, err.message, false);
      } else {
        onError?.(err);
        yield errorEvent("internal", "Something went wrong while answering. Please try again.", true);
      }
    }
  }

  return { events, release };
}
