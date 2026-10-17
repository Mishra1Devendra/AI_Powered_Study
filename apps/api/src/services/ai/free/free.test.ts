import { describe, expect, it } from "vitest";
import { PolicyViolation } from "../errors.js";
import { FREE_PROVIDERS, assertApprovedFreeModel } from "./catalog.js";

describe("Gemini model policy", () => {
  it("approves Gemini 3.5 Flash-Lite for its documented free tier", () => {
    expect(FREE_PROVIDERS.gemini.models).toEqual(["gemini-3.5-flash-lite"]);
    expect(FREE_PROVIDERS.gemini.defaultModel).toBe("gemini-3.5-flash-lite");
    expect(FREE_PROVIDERS.gemini.limits.note).toMatch(/disable Google Cloud billing/i);
    expect(assertApprovedFreeModel("gemini", "gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(() => assertApprovedFreeModel("gemini", "gemini-2.5-flash-lite")).toThrow(PolicyViolation);
  });
});
