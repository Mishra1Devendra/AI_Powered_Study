import { describe, expect, it, vi } from "vitest";
import { AIError, type AIErrorCode } from "./errors.js";
import { OllamaOrMockProvider } from "./mock-fallback.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "./types.js";

const req: GenerateTextRequest = { system: "Active tutor mode: none", messages: [{ role: "user", content: "Explain entropy" }] };

/** A scripted stand-in for Ollama. */
function ollama(script: () => AsyncGenerator<string, void, void>, generate?: () => Promise<never>) {
  const streamText = vi.fn((): TextStream => {
    const g = script();
    return (async function* () {
      yield* g;
      return { produced: { model: "llama3.2:3b", isMock: false } };
    })();
  });
  const provider: LLMProvider = {
    name: "ollama",
    model: "llama3.2:3b",
    isMock: false,
    streamText,
    generateText: generate ?? (async () => ({ text: "real", provider: "ollama", model: "llama3.2:3b", isMock: false })),
  };
  return { provider, streamText };
}

async function drain(stream: TextStream) {
  const parts: string[] = [];
  while (true) {
    const n = await stream.next();
    if (n.done) return { text: parts.join(""), end: n.value };
    parts.push(n.value);
  }
}

const down = () => new AIError("local_unavailable", "Local AI (Ollama) is not running.");

describe("OllamaOrMockProvider (the only fallback: Ollama -> MOCK)", () => {
  it("uses Ollama when it is available and labels the reply as real", async () => {
    const { provider } = ollama(async function* () {
      yield "Real ";
      yield "answer";
    });
    const { text, end } = await drain(new OllamaOrMockProvider(provider, 0).streamText(req));
    expect(text).toBe("Real answer");
    expect(end.produced).toEqual({ model: "llama3.2:3b", isMock: false });
  });

  it("falls back to the clearly-labelled MOCK when Ollama is not running, and says why", async () => {
    const { provider, streamText } = ollama(async function* () {
      throw down();
    });
    const { text, end } = await drain(new OllamaOrMockProvider(provider, 0).streamText(req));
    expect(text).toContain("[DEMO AI - mock provider, not a real model]");
    expect(text).toContain("Ollama) is not running");
    expect(text).toContain("ollama pull llama3.2:3b");
    expect(end.produced).toEqual({ model: "mock-demo", isMock: true });
    expect(streamText).toHaveBeenCalledTimes(1); // asked once, never retried
  });

  it.each<AIErrorCode>(["timeout", "bad_request", "unavailable", "rate_limited", "auth", "unknown", "refused"])(
    "does NOT hide a '%s' failure behind a fake answer",
    async (code) => {
      const { provider } = ollama(async function* () {
        throw new AIError(code, "x");
      });
      await expect(drain(new OllamaOrMockProvider(provider, 0).streamText(req))).rejects.toMatchObject({ code });
    },
  );

  it("does not splice a mock answer onto a real reply that broke part-way", async () => {
    const { provider } = ollama(async function* () {
      yield "partial real text";
      throw down();
    });
    const out: string[] = [];
    const stream = new OllamaOrMockProvider(provider, 0).streamText(req);
    await expect(
      (async () => {
        while (true) {
          const n = await stream.next();
          if (n.done) return;
          out.push(n.value);
        }
      })(),
    ).rejects.toMatchObject({ code: "local_unavailable" });
    expect(out.join("")).toBe("partial real text");
    expect(out.join("")).not.toContain("DEMO");
  });

  it("generateText follows the same rule", async () => {
    const unavailable = ollama(async function* () {}, async () => {
      throw down();
    });
    await expect(new OllamaOrMockProvider(unavailable.provider, 0).generateText(req)).resolves.toMatchObject({ isMock: true, provider: "mock" });
    const timeout = ollama(async function* () {}, async () => {
      throw new AIError("timeout", "slow");
    });
    await expect(new OllamaOrMockProvider(timeout.provider, 0).generateText(req)).rejects.toMatchObject({ code: "timeout" });
  });
});
