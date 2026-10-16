import { AIError, PolicyViolation } from "./errors.js";
import type { AiProbe, GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "./types.js";

/**
 * Ollama running ON THIS MACHINE. Free: no account, no API key, no billing, no cloud request.
 * Talks to the local HTTP API with plain `fetch` (no SDK, so nothing hidden can reach a paid
 * service). Two guards keep it local:
 *   1. the base URL must be a loopback address (a remote host could be a paid/cloud service);
 *   2. Ollama "cloud" models (names containing "cloud") are refused: they run on Ollama's servers.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CLOUD_MODEL = /(^|[-:/_.])cloud($|[-:/_.])/i;

export { PolicyViolation } from "./errors.js";

/** Throws unless `url` is a plain http(s) loopback address. Returns the normalised base URL. */
export function assertLocalOllamaUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PolicyViolation("OLLAMA_BASE_URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new PolicyViolation(
      "OLLAMA_BASE_URL must point at this machine (localhost / 127.0.0.1). A remote host could be a paid or cloud service, which is not allowed without explicit written approval.",
    );
  }
  if (parsed.username || parsed.password) throw new PolicyViolation("OLLAMA_BASE_URL must not contain credentials.");
  return parsed.origin;
}

/** Throws if the model name refers to an Ollama cloud model. */
export function assertLocalModel(model: string): string {
  if (!model.trim()) throw new PolicyViolation("OLLAMA_MODEL is empty.");
  if (CLOUD_MODEL.test(model)) {
    throw new PolicyViolation(
      `OLLAMA_MODEL "${model}" looks like an Ollama cloud model, which runs on remote servers and may be paid or limited. Use a model that runs locally.`,
    );
  }
  return model;
}

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Context window requested from Ollama (its default is small and silently truncates). */
  numCtx: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_TOKENS = 2048;

interface OllamaLine {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly isMock = false;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = assertLocalOllamaUrl(options.baseUrl);
    this.model = assertLocalModel(options.model);
    this.timeoutMs = options.timeoutMs;
    this.numCtx = options.numCtx;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private body(request: GenerateTextRequest, stream: boolean) {
    return JSON.stringify({
      model: this.model,
      stream,
      ...(request.json ? { format: "json" } : {}),
      messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
      options: { num_ctx: this.numCtx, num_predict: request.maxTokens ?? DEFAULT_MAX_TOKENS, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
    });
  }

  /** One intentional request to the local server. No retries: a failure is reported, not repeated. */
  private async open(request: GenerateTextRequest, stream: boolean): Promise<Response> {
    const signals = [AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs), ...(request.signal ? [request.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: this.body(request, stream),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (request.signal?.aborted) throw err; // caller-initiated, not a provider failure
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AIError("timeout", "The local AI took too long to respond.", true);
      }
      throw new AIError("local_unavailable", "Local AI (Ollama) is not running.", false);
    }
    if (res.ok && res.body) return res;
    if (res.status === 404) {
      throw new AIError("bad_request", `The local model "${this.model}" is not installed. Run: ollama pull ${this.model}`);
    }
    throw new AIError("unavailable", "The local AI returned an error.", true);
  }

  /**
   * Asks the local server which models it has (GET /api/tags). This LISTS models: it loads nothing and generates nothing, so it
   * is safe for health checks. Never throws.
   */
  async probe(): Promise<AiProbe> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1_500) });
      if (!res.ok) return { reachable: true, modelInstalled: null };
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === "string");
      return { reachable: true, modelInstalled: names.some((n) => n === this.model || n === `${this.model}:latest`) };
    } catch {
      return { reachable: false, modelInstalled: null };
    }
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
    return { text: trimmed, provider: this.name, model: this.model, isMock: false, ...(end.usage ? { usage: end.usage } : {}) };
  }

  async *streamText(request: GenerateTextRequest): TextStream {
    const res = await this.open(request, true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finished = false;

    const parse = (line: string): OllamaLine | null => {
      if (!line.trim()) return null;
      try {
        return JSON.parse(line) as OllamaLine;
      } catch {
        throw new AIError("unknown", "The local AI sent an unreadable response.", true);
      }
    };

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const parsed = parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!parsed) continue;
          if (parsed.error) throw new AIError("unavailable", "The local AI reported an error.", true);
          const piece = parsed.message?.content;
          if (piece) yield piece;
          if (parsed.done) {
            finished = true;
            if (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined) {
              usage = { inputTokens: parsed.prompt_eval_count ?? 0, outputTokens: parsed.eval_count ?? 0 };
            }
            break;
          }
        }
      }
      // A final line without a trailing newline.
      if (!finished && buffer.trim()) {
        const parsed = parse(buffer);
        if (parsed?.message?.content) yield parsed.message.content;
      }
      return { ...(usage ? { usage } : {}), produced: { model: this.model, isMock: false } };
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (request.signal?.aborted) throw err;
      if (err instanceof Error && err.name === "TimeoutError") throw new AIError("timeout", "The local AI took too long to respond.", true);
      throw new AIError("unavailable", "Lost the connection to the local AI.", true);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
