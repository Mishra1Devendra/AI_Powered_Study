export type AIErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth"
  | "bad_request"
  | "unavailable"
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

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}
