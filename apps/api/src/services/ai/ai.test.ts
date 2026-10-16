import { describe, expect, it, vi } from "vitest";
import { createDisabledLLMProvider, createLLMProvider, PolicyViolation } from "./index.js";
import { AIError } from "./errors.js";
import { geminiHttpError } from "./free/gemini.js";

const base = {
  AI_PROVIDER: "gemini" as const,
  GEMINI_API_KEY: "AIzaTESTKEYTESTKEYTESTKEYTESTKEY12345",
  GEMINI_MODEL: "gemini-2.5-flash-lite",
  GEMINI_BILLING_DISABLED: true,
  AI_TIMEOUT_MS: 1000,
};

describe("the Gemini-only AI configuration", () => {
  it("fails closed while the candidate model's free-tier eligibility is unverified", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createLLMProvider(base, fetchImpl)).toThrow(PolicyViolation);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("disabled AI provider", () => {
    it("returns explicit unavailable errors and reports a disabled status without contacting a provider", async () => {
      const provider = createDisabledLLMProvider();
      expect(provider).toMatchObject({ name: "disabled", model: "disabled", isMock: false });
      await expect(provider.generateText({ messages: [] })).rejects.toMatchObject({
        code: "unavailable",
        message: "AI is disabled for this deployment. No AI provider was contacted.",
      });
      await expect(async () => {
        for await (const _ of provider.streamText({ messages: [] })) void _;
      }).rejects.toMatchObject({ code: "unavailable" });
      await expect(provider.status?.()).resolves.toMatchObject({
        mode: "disabled",
        steps: [{ service: "AI disabled", state: "not_running", where: "disabled" }],
      });
    });
  });

  it("requires a server-side key and an explicit verified model before creating a provider", () => {
    expect(() => createLLMProvider({ ...base, GEMINI_API_KEY: undefined })).toThrow(PolicyViolation);
    expect(() => createLLMProvider({ ...base, GEMINI_MODEL: undefined })).toThrow(PolicyViolation);
    expect(() => createLLMProvider({ ...base, GEMINI_BILLING_DISABLED: false })).toThrow(PolicyViolation);
  });

  it("maps quota exhaustion and provider errors to safe Gemini-only errors", () => {
    const quota = geminiHttpError(429);
    expect(quota).toBeInstanceOf(AIError);
    expect(quota).toMatchObject({ code: "rate_limited", retryable: true });
    expect(quota.message).toMatch(/Gemini.*free request limit/i);

    const unavailable = geminiHttpError(503);
    expect(unavailable).toMatchObject({ code: "unavailable", retryable: true });
    expect(unavailable.message).toBe("Google Gemini returned an error.");
    expect(geminiHttpError(403).message).not.toMatch(/key|credential|secret/i);
  });
});
