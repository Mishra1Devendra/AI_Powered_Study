import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuthOnlyClient } from "./supabase";

/**
 * The browser only gets the sign-in half of the Supabase client (see lib/supabase.ts). If someone calls the database, storage or
 * realtime parts, it would crash at runtime in production - so this test finds it first.
 */
const srcDir = join(import.meta.dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "dev" ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("the browser's Supabase client is auth-only", () => {
  it("no code reaches for anything but .auth on the client", () => {
    const offenders: string[] = [];
    for (const file of files(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:client|supabase)\.(?!auth\b)([a-zA-Z_]+)\s*[(.]/g)) {
        // `client.something` that is not the Supabase client (e.g. a local variable named client elsewhere) is listed so a human can judge.
        offenders.push(`${relative(srcDir, file).split("\\").join("/")}: client.${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses the same storage key, auth URL and PKCE settings the full client would, so existing sign-ins keep working", () => {
    const client = createAuthOnlyClient("https://abcdefghij.supabase.co", "sb_publishable_test_key") as unknown as {
      auth: { storageKey: string; url: string; flowType: string; headers: Record<string, string>; persistSession: boolean; autoRefreshToken: boolean; detectSessionInUrl: boolean };
    };
    expect(client.auth.storageKey).toBe("sb-abcdefghij-auth-token");
    expect(client.auth.url).toBe("https://abcdefghij.supabase.co/auth/v1");
    expect(client.auth.flowType).toBe("pkce");
    expect(client.auth.persistSession).toBe(true);
    expect(client.auth.autoRefreshToken).toBe(true);
    expect(client.auth.detectSessionInUrl).toBe(true);
    expect(client.auth.headers.apikey).toBe("sb_publishable_test_key");
    expect(client.auth.headers.Authorization).toBe("Bearer sb_publishable_test_key");
  });

  it("copes with a project URL that already ends in a slash", () => {
    const client = createAuthOnlyClient("https://abcdefghij.supabase.co/", "k") as unknown as { auth: { url: string; storageKey: string } };
    expect(client.auth.url).toBe("https://abcdefghij.supabase.co/auth/v1");
    expect(client.auth.storageKey).toBe("sb-abcdefghij-auth-token");
  });

  it("exposes the auth methods the app uses", () => {
    const client = createAuthOnlyClient("https://abcdefghij.supabase.co", "k");
    for (const method of ["getSession", "signInWithPassword", "signUp", "signOut", "updateUser", "onAuthStateChange"] as const) {
      expect(typeof client.auth[method]).toBe("function");
    }
  });
});
