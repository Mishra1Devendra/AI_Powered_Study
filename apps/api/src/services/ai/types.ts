import type { AiStatusReport } from "@copilot/shared";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTextRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Ask the model for a single valid JSON value (Ollama's local `format: "json"`). Used by quiz generation. */
  json?: boolean;
  /** Overrides the provider's default time limit for THIS call (long structured generations on a slow CPU). */
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
 * Only zero-cost providers exist in this codebase: a local Ollama server, the demo mock, and "free-ai" - the free-tier chain
 * (local first, then the approved FREE online services in services/ai/free/catalog.ts; never a paid one). "free-ai" is deliberately
 * opaque: which online service answered is not exposed. Adding anything else needs the owner's explicit written approval
 * (see docs/AI_POLICY.md) - do not widen this union on your own.
 */
export type ProviderName = "ollama" | "mock" | "free-ai";

export interface StreamEnd {
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Who actually produced this reply. Present when it can differ from the configured provider
   * (e.g. the mock answered because Ollama was unavailable), so replies are never mislabelled.
   */
  produced?: { model: string; isMock: boolean };
}

/** Yields text deltas as they arrive; the generator's return value carries the final metadata. */
export type TextStream = AsyncGenerator<string, StreamEnd, void>;

/** What a health check may learn WITHOUT generating anything. */
export interface AiProbe {
  /** The local AI server answered. */
  reachable: boolean;
  /** The configured model is installed (null when that could not be determined). */
  modelInstalled: boolean | null;
}

/** The only surface the rest of the app uses to talk to an LLM. */
export interface LLMProvider {
  /** A cheap "is it there?" check (no generation, no cost). Only providers with something to ask implement it. */
  probe?(): Promise<AiProbe>;
  /** Which services are in the chain, which answered last and their free limits. For administrators only; makes no AI request. */
  status?(): Promise<AiStatusReport>;
  readonly name: ProviderName;
  readonly model: string;
  readonly isMock: boolean;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  streamText(request: GenerateTextRequest): TextStream;
}
