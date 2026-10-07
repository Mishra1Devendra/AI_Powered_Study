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
