import type { AiStatusReport } from "@copilot/shared";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTextRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Ask the provider for a single valid JSON value. Used by structured generation. */
  json?: boolean;
  /** Overrides the provider's default time limit for this call. */
  timeoutMs?: number;
  /** Sampling temperature (lower = more focused). Omit for the model's default. */
  temperature?: number;
  /** Aborts the provider call (client disconnected, deadline hit). */
  signal?: AbortSignal;
}

export interface GenerateTextResult {
  text: string;
  provider: ProviderName;
  model: string;
  /** True when the text is canned demo output rather than a real model response. */
  isMock: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * "free-ai" is the public, opaque provider label for the sole configured Google Gemini API provider. Historical Ollama/mock values
 * remain in this type because older AI results may already be stored; "disabled" is used when deployment AI is explicitly off.
 */
export type ProviderName = "ollama" | "mock" | "free-ai" | "disabled";

export interface StreamEnd {
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Who actually produced this reply when it can differ from the configured provider.
   */
  produced?: { model: string; isMock: boolean };
}

/** Yields text deltas as they arrive; the generator's return value carries the final metadata. */
export type TextStream = AsyncGenerator<string, StreamEnd, void>;

/** What a health check may learn WITHOUT generating anything. */
export interface AiProbe {
  /** A provider probe succeeded. */
  reachable: boolean;
  /** The configured model is available (null when that could not be determined). */
  modelInstalled: boolean | null;
}

/** The only surface the rest of the app uses to talk to an LLM. */
export interface LLMProvider {
  /** A non-generative availability check. Only providers with a safe probe implement it. */
  probe?(): Promise<AiProbe>;
  /** Configured provider status. For administrators only; makes no AI request. */
  status?(): Promise<AiStatusReport>;
  readonly name: ProviderName;
  readonly model: string;
  readonly isMock: boolean;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  streamText(request: GenerateTextRequest): TextStream;
}
