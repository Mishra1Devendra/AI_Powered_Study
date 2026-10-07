export type AIErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth"
  | "bad_request"
  | "unavailable"
  /** Ollama is not reachable on this machine (not installed / not running). Triggers the MOCK fallback, never a paid one. */
  | "local_unavailable"
  | "empty_response"
  | "refused"
  | "unknown";

/** Typed, UI-safe error. `message` never contains keys, prompts or provider internals. */
export class AIError extends Error {
  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AIError";
  }
}
