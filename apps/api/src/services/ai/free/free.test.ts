import { describe, expect, it } from "vitest";
import { PolicyViolation } from "../errors.js";
import { FREE_PROVIDERS, assertApprovedFreeModel } from "./catalog.js";

describe("Gemini model policy", () => {
  it("does not mark a model as free while current eligibility is unverified", () => {
    expect(FREE_PROVIDERS.gemini.models).toEqual([]);
    expect(FREE_PROVIDERS.gemini.defaultModel).toBeNull();
    expect(FREE_PROVIDERS.gemini.limits.note).toMatch(/unverified/i);
    expect(() => assertApprovedFreeModel("gemini", "gemini-2.5-flash-lite")).toThrow(PolicyViolation);
  });
});
