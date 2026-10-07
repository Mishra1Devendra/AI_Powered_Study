import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export interface AuthUser {
  id: string;
  email: string | null;
}

/** Verifies a Supabase access token and returns the user it identifies, or null. */
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

const claimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.literal("authenticated"),
  email: z.string().optional(),
});

/**
 * Verifies tokens locally against the project's public signing keys (JWKS, cached by `jose`).
 * No Supabase secret is needed or held by this server for verification.
 * Checks signature, expiry, issuer and audience; the anon key (role=anon) is rejected.
 */
export function createTokenVerifier(
  supabaseUrl: string,
  keys?: JWTVerifyGetKey,
): TokenVerifier {
  const base = supabaseUrl.replace(/\/+$/, "");
  const jwks =
    keys ??
    createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), { cooldownDuration: 30_000 });
  const issuer = `${base}/auth/v1`;

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: "authenticated",
        algorithms: ["ES256", "RS256"],
      });
      const claims = claimsSchema.parse(payload);
      return { id: claims.sub, email: claims.email ?? null };
    } catch {
      return null;
    }
  };
}
