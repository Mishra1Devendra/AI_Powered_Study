import { AIError } from "../errors.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "../types.js";
import { FREE_PROVIDERS, assertApprovedFreeModel } from "./catalog.js";

const DEFAULT_MAX_TOKENS = 2048;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: unknown;
}

export function geminiHttpError(status: number): AIError {
  if (status === 429) return new AIError("rate_limited", "Google Gemini's free request limit was reached. Try again later.", true);
  if (status === 401 || status === 403) return new AIError("auth", "Google Gemini is unavailable with the configured access.");
  if (status === 400 || status === 404) return new AIError("bad_request", "Google Gemini could not handle this request.");
  return new AIError("unavailable", "Google Gemini returned an error.", true);
}

/**
 * Google Gemini API. The key goes in a request header (never in the URL); this adapter never retries or selects another provider.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "free-ai" as const;
  readonly isMock = false;
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiOptions) {
    if (!options.apiKey.trim()) throw new AIError("auth", "Google Gemini is not configured.");
    this.apiKey = options.apiKey.trim();
    this.model = assertApprovedFreeModel("gemini", options.model);
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async open(request: GenerateTextRequest): Promise<Response> {
    const signals = [AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs), ...(request.signal ? [request.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${FREE_PROVIDERS.gemini.origin}/v1beta/models/${this.model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          contents: request.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: {
            maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new AIError("timeout", "Google Gemini took too long to respond.", true);
      throw new AIError("unavailable", "Google Gemini could not be reached.", true);
    }
    if (res.ok && res.body) return res;
    throw geminiHttpError(res.status);
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    let text = "";
    const stream = this.streamText(request);
    let end;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        end = next.value;
        break;
      }
      text += next.value;
    }
    const trimmed = text.trim();
    if (!trimmed) throw new AIError("empty_response", "The AI returned an empty response.", true);
    return { text: trimmed, provider: this.name, model: "free-online-ai", isMock: false, ...(end.usage ? { usage: end.usage } : {}) };
  }

  async *streamText(request: GenerateTextRequest): TextStream {
    const res = await this.open(request);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    const handle = (line: string): string | null => {
      const t = line.trim();
      if (!t.startsWith("data:")) return null;
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(t.slice(5).trim()) as GeminiChunk;
      } catch {
        throw new AIError("unknown", "Google Gemini sent an unreadable response.", true);
      }
      if (chunk.error) throw new AIError("unavailable", "Google Gemini reported an error.", true);
      if (chunk.usageMetadata) usage = { inputTokens: chunk.usageMetadata.promptTokenCount ?? 0, outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0 };
      const text = (chunk.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return text || null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const piece = handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (piece) yield piece;
        }
      }
      if (buffer.trim()) {
        const piece = handle(buffer);
        if (piece) yield piece;
      }
      return { ...(usage ? { usage } : {}), produced: { model: "free-online-ai", isMock: false } };
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (request.signal?.aborted) throw err;
      if (err instanceof Error && err.name === "TimeoutError") throw new AIError("timeout", "Google Gemini took too long to respond.", true);
      throw new AIError("unavailable", "Lost the connection to Google Gemini.", true);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
