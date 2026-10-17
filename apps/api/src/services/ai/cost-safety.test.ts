import { describe, expect, it } from "vitest";
import { assessAiCost, findPaidAiCredentials, formatCostReport } from "./cost-safety.js";

const input = {
  AI_PROVIDER: "gemini",
  GEMINI_API_KEY: "AIzaTESTKEYTESTKEYTESTKEYTESTKEY12345",
  GEMINI_MODEL: "gemini-2.5-flash-lite",
  GEMINI_BILLING_DISABLED: true,
};

describe("assessAiCost", () => {
  it("blocks an unapproved model and reports billing state as operator-attested only", () => {
    const report = assessAiCost(input, {});
    expect(report).toMatchObject({
      provider: "Google Gemini API",
      model: "gemini-2.5-flash-lite",
      execution: "Online (Google Gemini API)",
      cloudRequest: true,
      paid: false,
      billingDisabledAttested: true,
      estimatedCost: "UNKNOWN",
      result: "BLOCKED",
    });
    expect(report.reasons.join(" ")).toMatch(/not approved for the free tier/i);
    expect(report.reasons.join(" ")).toMatch(/operator-attested only/i);
  });

  it("permits the documented free-tier model only with a billing-disabled attestation", () => {
    const report = assessAiCost({ ...input, GEMINI_MODEL: "gemini-3.5-flash-lite" }, {});
    expect(report).toMatchObject({
      model: "gemini-3.5-flash-lite",
      billingDisabledAttested: true,
      result: "SAFE",
    });
  });

  it("blocks missing credentials, billing confirmation, or a non-Gemini provider", () => {
    expect(assessAiCost({ ...input, GEMINI_API_KEY: undefined }, {}).result).toBe("BLOCKED");
    expect(assessAiCost({ ...input, GEMINI_BILLING_DISABLED: false }, {}).result).toBe("BLOCKED");
    expect(assessAiCost({ ...input, AI_PROVIDER: "ollama" }, {}).result).toBe("BLOCKED");
  });

  it("reports credential names only and never exposes values", () => {
    const source = {
      ANTHROPIC_API_KEY: "sk-ant-SECRET-VALUE",
      OPENAI_API_KEY: "sk-SECRET-OPENAI",
      GEMINI_API_KEY: input.GEMINI_API_KEY,
      DATABASE_URL: "postgresql://database-secret",
    };
    const found = findPaidAiCredentials(source);
    expect(found.keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(found.freeKeys).toEqual(["GEMINI_API_KEY"]);
    const report = formatCostReport(assessAiCost(input, source));
    expect(report).not.toMatch(/SECRET|database-secret|AIza/);
    expect(report).toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY");
  });
});
