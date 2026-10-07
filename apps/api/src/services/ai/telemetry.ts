import { AIError } from "./errors.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "./types.js";

/** Where structured events go (a pino-style logger). Content of prompts and replies is NEVER passed to it. */
export interface AiLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * A transparent wrapper that records, for every AI call the app makes: what kind, how long, whether it worked and (on failure) the
 * error CODE. Nothing about the content (prompt, reply, student text) is logged. It never starts a call on its own and never
 * retries: it only forwards what the application asked for, so it adds no new AI call site and no cost.
 */
export function withTelemetry(inner: LLMProvider, log: AiLog, now: () => number = () => performance.now()): LLMProvider {
  const base = (op: "generate" | "stream", req: GenerateTextRequest) => ({ event: "ai_call", op, provider: inner.name, model: inner.model, json: req.json === true, messages: req.messages.length });
  const code = (err: unknown) => (err instanceof AIError ? err.code : err instanceof Error && err.name === "AbortError" ? "aborted" : "error");

  return {
    name: inner.name,
    model: inner.model,
    isMock: inner.isMock,
    ...(inner.probe ? { probe: () => inner.probe!() } : {}),
    ...(inner.status ? { status: () => inner.status!() } : {}),

    async generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
      const t0 = now();
      try {
        const out = await inner.generateText(req);
        log.info({ ...base("generate", req), ms: Math.round(now() - t0), ok: true, mock: out.isMock, ...(out.usage ? { tokensIn: out.usage.inputTokens, tokensOut: out.usage.outputTokens } : {}) }, "ai call finished");
        return out;
      } catch (err) {
        log.warn({ ...base("generate", req), ms: Math.round(now() - t0), ok: false, code: code(err) }, "ai call failed");
        throw err;
      }
    },

    async *streamText(req: GenerateTextRequest): TextStream {
      const t0 = now();
      let firstByteMs: number | null = null;
      const stream = inner.streamText(req);
      try {
        while (true) {
          const next = await stream.next();
          if (next.done) {
            const end = next.value;
            log.info(
              { ...base("stream", req), ms: Math.round(now() - t0), firstByteMs, ok: true, mock: end.produced?.isMock ?? inner.isMock, ...(end.usage ? { tokensIn: end.usage.inputTokens, tokensOut: end.usage.outputTokens } : {}) },
              "ai call finished",
            );
            return end;
          }
          firstByteMs ??= Math.round(now() - t0);
          yield next.value;
        }
      } catch (err) {
        log.warn({ ...base("stream", req), ms: Math.round(now() - t0), firstByteMs, ok: false, code: code(err) }, "ai call failed");
        throw err;
      }
    },
  };
}
