import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier, type TokenVerifier } from "./verify-token.js";

const SUPABASE_URL = "https://proj.supabase.co";
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let verify: TokenVerifier;
let privateKey: Key;
let otherKey: Key;

async function sign(
  claims: Record<string, unknown>,
  opts: { key?: Key; iss?: string; aud?: string; exp?: string | number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(opts.iss ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience(opts.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  verify = createTokenVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
});

describe("createTokenVerifier", () => {
  it("accepts a valid authenticated token and returns the user", async () => {
    const token = await sign({ sub: USER_ID, role: "authenticated", email: "a@b.co" });
    expect(await verify(token)).toEqual({ id: USER_ID, email: "a@b.co" });
  });

  it("rejects an expired token", async () => {
    const token = await sign({ sub: USER_ID, role: "authenticated" }, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await verify(token)).toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    const token = await sign({ sub: USER_ID, role: "authenticated" }, { key: otherKey });
    expect(await verify(token)).toBeNull();
  });

  it("rejects the wrong issuer or audience", async () => {
    expect(await verify(await sign({ sub: USER_ID, role: "authenticated" }, { iss: "https://evil.example/auth/v1" }))).toBeNull();
    expect(await verify(await sign({ sub: USER_ID, role: "authenticated" }, { aud: "other" }))).toBeNull();
  });

  it("rejects non-user tokens (anon role, missing or non-uuid sub)", async () => {
    expect(await verify(await sign({ role: "anon" }))).toBeNull();
    expect(await verify(await sign({ sub: USER_ID, role: "anon" }))).toBeNull();
    expect(await verify(await sign({ sub: "not-a-uuid", role: "authenticated" }))).toBeNull();
  });

  it("rejects garbage and unsigned (alg=none) tokens", async () => {
    expect(await verify("garbage")).toBeNull();
    const none = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ sub: USER_ID, role: "authenticated" }))}.`;
    expect(await verify(none)).toBeNull();
  });
});
