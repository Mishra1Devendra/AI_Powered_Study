import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SUPABASE_URL: "https://example.supabase.co",
};

describe("loadEnv", () => {
  it("applies defaults and treats empty optional values as unset", () => {
    const env = loadEnv({ ...base, SUPABASE_ANON_KEY: "  " });
    expect(env.API_PORT).toBe(3001);
    expect(env.SUPABASE_ANON_KEY).toBeUndefined();
    expect(env.AI_ENABLED).toBe(false);
    expect(env.AI_PROVIDER).toBe("gemini");
    expect(env.GEMINI_BILLING_DISABLED).toBe(false);
  });

  it("enables AI only by explicit configuration", () => {
    expect(loadEnv({ ...base, AI_ENABLED: "true" }).AI_ENABLED).toBe(true);
    expect(() => loadEnv({ ...base, AI_ENABLED: "yes" })).toThrow(EnvError);
  });

  it("rejects local or alternate providers when AI is enabled, but ignores inactive provider settings", () => {
    expect(loadEnv({ ...base, AI_PROVIDER: "gemini" }).AI_PROVIDER).toBe("gemini");
    expect(loadEnv({ ...base, AI_PROVIDER: "ollama" })).toMatchObject({ AI_ENABLED: false, AI_PROVIDER: "ollama" });
    for (const provider of ["ollama", "mock", "free", "groq", "openrouter", "openai"]) {
      expect(() => loadEnv({ ...base, AI_ENABLED: "true", AI_PROVIDER: provider })).toThrow(/must be 'gemini' when AI_ENABLED=true/);
    }
  });

  it("parses the billing-disabled operator attestation strictly", () => {
    expect(loadEnv({ ...base, GEMINI_BILLING_DISABLED: "true" }).GEMINI_BILLING_DISABLED).toBe(true);
    expect(() => loadEnv({ ...base, GEMINI_BILLING_DISABLED: "yes" })).toThrow(EnvError);
  });

  it("does not trust proxy headers unless TRUST_PROXY=true", () => {
    expect(loadEnv(base).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(() => loadEnv({ ...base, TRUST_PROXY: "yes" })).toThrow(EnvError);
  });

  it("fails fast when DATABASE_URL is missing, without echoing values", () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    expect(() => loadEnv({ DATABASE_URL: "mysql://secret-value" })).toThrow(/must start with postgresql/);
    try {
      loadEnv({ DATABASE_URL: "mysql://secret-value" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-value");
    }
  });
});
