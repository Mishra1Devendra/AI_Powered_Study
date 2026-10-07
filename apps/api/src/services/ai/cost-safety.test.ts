import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import { assessAiCost, findPaidAiCredentials, formatCostReport } from "./cost-safety.js";

const ollama = { AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2:3b" };

describe("assessAiCost", () => {
  it("Ollama on this machine is SAFE and reports zero cost, local execution, no billing, no key", () => {
    const r = assessAiCost(ollama, {});
    expect(r).toMatchObject({
      provider: "Ollama",
      execution: "Local (this device)",
      cloudRequest: false,
      paid: false,
      billingRequired: false,
      apiKeyRequired: false,
      potentialAutomaticBilling: false,
      estimatedCost: "INR 0 / USD 0",
      result: "SAFE",
    });
    const text = formatCostReport(r);
    expect(text).toContain("Provider:                     Ollama");
    expect(text).toContain("Cloud request:                No");
    expect(text).toContain("Result:                       SAFE");
  });

  it("the mock is SAFE", () => {
    expect(assessAiCost({ ...ollama, AI_PROVIDER: "mock" }, {})).toMatchObject({ result: "SAFE", execution: "None (canned demo replies)", paid: false });
  });

  it("a remote Ollama address is BLOCKED", () => {
    const r = assessAiCost({ ...ollama, OLLAMA_BASE_URL: "https://some-hosted-ollama.example.com" }, {});
    expect(r.result).toBe("BLOCKED");
    expect(r.cloudRequest).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/this machine/);
  });

  it("an Ollama cloud model is BLOCKED", () => {
    expect(assessAiCost({ ...ollama, OLLAMA_MODEL: "gpt-oss:120b-cloud" }, {}).result).toBe("BLOCKED");
  });

  it.each(["anthropic", "openai", "gemini", "azure-openai", "bedrock", "ollama,anthropic", ""])("any other provider ('%s') NEEDS_APPROVAL", (p) => {
    const r = assessAiCost({ ...ollama, AI_PROVIDER: p }, {});
    expect(r.result).toBe("NEEDS_APPROVAL");
    expect(r.paid).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/explicit written authorization/);
  });
});

describe("paid credentials are detected, reported by name only, and never used", () => {
  const source = {
    ANTHROPIC_API_KEY: "sk-ant-SECRET-VALUE",
    OPENAI_API_KEY: "sk-SECRET-OPENAI",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "AIza-SECRET",
    ANTHROPIC_BASE_URL: "https://proxy.example.com",
    DATABASE_URL: "postgresql://x",
    SUPABASE_ANON_KEY: "public",
  };

  it("lists names of non-empty paid keys and endpoints but never their values", () => {
    const found = findPaidAiCredentials(source);
    expect(found.keys).toEqual(["ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"]);
    expect(found.endpoints).toEqual(["ANTHROPIC_BASE_URL"]);
    const report = formatCostReport(assessAiCost(ollama, source));
    expect(report).not.toMatch(/SECRET|proxy\.example|sk-/);
    expect(report).toContain("YES (ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY) - ignored, never used");
  });

  it("their presence does not change the provider or make the result unsafe (they are simply ignored)", () => {
    expect(assessAiCost(ollama, source)).toMatchObject({ provider: "Ollama", result: "SAFE", paid: false });
  });

  it("does not mistake the database or Supabase keys for AI credentials", () => {
    expect(findPaidAiCredentials({ DATABASE_URL: "x", SUPABASE_ANON_KEY: "y", SUPABASE_SERVICE_ROLE_KEY: "z" })).toEqual({ keys: [], endpoints: [], freeKeys: [] });
  });
});

describe("AI_PROVIDER configuration cannot be set to a paid provider", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co" };

  it("defaults to local Ollama", () => {
    expect(loadEnv(base)).toMatchObject({ AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434" });
  });

  it.each(["anthropic", "openai", "gemini", "azure", "bedrock", "ollama,anthropic"])("rejects AI_PROVIDER=%s with the approval message", (p) => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: p })).toThrow(/explicit written approval/);
  });

  it("accepts the two safe values", () => {
    expect(loadEnv({ ...base, AI_PROVIDER: "mock" }).AI_PROVIDER).toBe("mock");
    expect(loadEnv({ ...base, AI_PROVIDER: "ollama" }).AI_PROVIDER).toBe("ollama");
  });

  it("ignores paid keys placed in the environment: they never become config", () => {
    const env = loadEnv({ ...base, ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-x" }) as Record<string, unknown>;
    expect(JSON.stringify(env)).not.toMatch(/sk-ant|sk-x|ANTHROPIC|OPENAI/);
  });
});
