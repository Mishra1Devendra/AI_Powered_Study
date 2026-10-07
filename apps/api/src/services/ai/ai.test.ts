import { describe, expect, it } from "vitest";
import { createLLMProvider, PolicyViolation } from "./index.js";
import { MOCK_BANNER } from "./mock-provider.js";

const base = { AI_PROVIDER: "ollama" as const, OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b", OLLAMA_NUM_CTX: 8192, AI_TIMEOUT_MS: 1000 };

describe("createLLMProvider", () => {
  it("AI_PROVIDER=ollama selects the local Ollama provider (with the mock as its only fallback)", () => {
    const ai = createLLMProvider(base);
    expect(ai.name).toBe("ollama");
    expect(ai.model).toBe("llama3.2:3b");
    expect(ai.isMock).toBe(false);
  });

  it("AI_PROVIDER=mock selects the labelled mock provider", async () => {
    const ai = createLLMProvider({ ...base, AI_PROVIDER: "mock" });
    expect(ai.name).toBe("mock");
    expect(ai.isMock).toBe(true);
    const res = await ai.generateText({ messages: [{ role: "user", content: "What is 2+2?" }] });
    expect(res.isMock).toBe(true);
    expect(res.text).toContain(MOCK_BANNER);
  });

  it.each(["https://api.openai.com", "https://api.anthropic.com", "http://192.168.1.20:11434", "http://example.com:11434", "http://localhost.evil.com:11434", "http://user:pw@localhost:11434"])(
    "refuses a non-local Ollama address (%s)",
    (url) => {
      expect(() => createLLMProvider({ ...base, OLLAMA_BASE_URL: url })).toThrow(PolicyViolation);
    },
  );

  it("refuses Ollama cloud models, which run on remote servers", () => {
    expect(() => createLLMProvider({ ...base, OLLAMA_MODEL: "gpt-oss:120b-cloud" })).toThrow(PolicyViolation);
  });
});
