import { AIError } from "../errors.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "../types.js";
import { FREE_PROVIDERS, assertApprovedFreeModel, type FreeProviderId } from "./catalog.js";

/** Providers that speak the common "chat completions" protocol. */
type ChatId = Extract<FreeProviderId, "groq" | "openrouter">;
const PATH: Record<ChatId, string> = { groq: "/openai/v1/chat/completions", openrouter: "/api/v1/chat/completions" };
const DEFAULT_MAX_TOKENS = 2048;

export interface ChatCompletionsOptions {
  id: ChatId;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface Chunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
}

/**
 * One free provider over the chat-completions protocol. The origin is fixed in the catalog, the model must be approved as free,
 * the key stays inside this object (never in a message, a URL or a log), and one call is ONE request: no retries here - the
 * chain moves to the next free provider instead.
 */
export class ChatCompletionsProvider implements LLMProvider {
  readonly name = "free-ai" as const;
  readonly isMock = false;
  readonly model: string;
  private readonly id: ChatId;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChatCompletionsOptions) {
    if (!options.apiKey.trim()) throw new AIError("auth", "A free AI service is not configured.");
    this.id = options.id;
    this.apiKey = options.apiKey.trim();
    this.model = assertApprovedFreeModel(options.id, options.model);
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async open(request: GenerateTextRequest): Promise<Response> {
    const signals = [AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs), ...(request.signal ? [request.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${FREE_PROVIDERS[this.id].origin}${PATH[this.id]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new AIError("timeout", "A free AI service took too long to respond.", true);
      throw new AIError("unavailable", "A free AI service could not be reached.", true);
    }
    if (res.ok && res.body) return res;
    // Every refusal is classified by status only; the body (which could echo details) is never read or shown.
    if (res.status === 429 || res.status === 402) throw new AIError("rate_limited", "A free AI service has reached its free limit.", true);
    if (res.status === 401 || res.status === 403) throw new AIError("auth", "A free AI service is not available with the configured access.");
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new AIError("bad_request", "A free AI service could not handle this request.");
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
    let done = false;

    const handle = (line: string): string | null => {
      const t = line.trim();
      if (!t.startsWith("data:")) return null;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        return null;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload) as Chunk;
      } catch {
        throw new AIError("unknown", "A free AI service sent an unreadable response.", true);
      }
      if (chunk.error) throw new AIError("unavailable", "A free AI service reported an error.", true);
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      return chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? null;
    };

    try {
      while (!done) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const piece = handle(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (piece) yield piece;
        }
      }
      if (!done && buffer.trim()) {
        const piece = handle(buffer);
        if (piece) yield piece;
      }
      // The model name is opaque on purpose: which free service answered is not shown to students or stored.
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
