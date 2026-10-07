import { AIError } from "./errors.js";
import { MockProvider } from "./mock-provider.js";
import type { AiProbe, GenerateTextRequest, GenerateTextResult, LLMProvider, StreamEnd, TextStream } from "./types.js";

/**
 * Policy: Ollama available -> use Ollama; Ollama unavailable -> use the MOCK. Never a paid
 * provider. This wrapper is the ONLY fallback in the system and its only target is the mock:
 * it has no other provider to switch to.
 *
 * It falls back only when Ollama could not be reached AT ALL, before any text was produced.
 * Every other failure (timeout, missing model, mid-reply loss) is reported as an error, not
 * hidden behind a fake answer. Replies produced by the mock say so, in the text and in the
 * stored `isMock` / `model` metadata.
 */
export class OllamaOrMockProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly isMock = false;

  constructor(
    private readonly ollama: LLMProvider,
    private readonly chunkDelayMs = 12,
  ) {}

  get model(): string {
    return this.ollama.model;
  }

  probe(): Promise<AiProbe> {
    return this.ollama.probe ? this.ollama.probe() : Promise.resolve({ reachable: false, modelInstalled: null });
  }

  private mock() {
    return new MockProvider(
      this.chunkDelayMs,
      `Local AI (Ollama) is not running, so this is a canned demo reply. To get real answers, start Ollama and install the model: ollama pull ${this.ollama.model}`,
    );
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    try {
      return await this.ollama.generateText(request);
    } catch (err) {
      if (err instanceof AIError && err.code === "local_unavailable") return this.mock().generateText(request);
      throw err;
    }
  }

  async *streamText(request: GenerateTextRequest): TextStream {
    const stream = this.ollama.streamText(request);
    let first: IteratorResult<string, StreamEnd>;
    try {
      first = await stream.next();
    } catch (err) {
      if (err instanceof AIError && err.code === "local_unavailable") return yield* this.mock().streamText(request);
      throw err;
    }
    if (first.done) return first.value;
    yield first.value;
    return yield* stream;
  }
}
