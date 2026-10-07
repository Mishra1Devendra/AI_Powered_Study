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

/**
 * Google's free tier. The key goes in a request HEADER (never in the URL, so it cannot show up in a log line or an error message).
 * One call = one request; on any refusal the chain moves to the next free provider - this adapter never retries.
 */
export class GeminiFreeProvider implements LLMProvider {
  readonly name = "free-ai" as const;
  readonly isMock = false;
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiOptions) {
    if (!options.apiKey.trim()) throw new AIError("auth", "A free AI service is not configured.");
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
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new AIError("timeout", "A free AI service took too long to respond.", true);
      throw new AIError("unavailable", "A free AI service could not be reached.", true);
    }
    if (res.ok && res.body) return res;
    if (res.status === 429) throw new AIError("rate_limited", "A free AI service has reached its free limit.", true);
    if (res.status === 401 || res.status === 403) throw new AIError("auth", "A free AI service is not available with the configured access.");
    if (res.status === 400 || res.status === 404) throw new AIError("bad_request", "A free AI service could not handle this request.");
    throw new AIError("unavailable", "A free AI service returned an error.", true);
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
        throw new AIError("unknown", "A free AI service sent an unreadable response.", true);
      }
      if (chunk.error) throw new AIError("unavailable", "A free AI service reported an error.", true);
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
      if (err instanceof Error && err.name === "TimeoutError") throw new AIError("timeout", "A free AI service took too long to respond.", true);
      throw new AIError("unavailable", "Lost the connection to a free AI service.", true);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
