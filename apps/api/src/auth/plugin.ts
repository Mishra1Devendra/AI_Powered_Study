import type { FastifyReply, FastifyRequest } from "fastify";
import { ACCESS_REVOKED_CODE, ACCESS_REVOKED_MESSAGE, type Role } from "@copilot/shared";
import type { AccessRepository } from "../access/repository.js";
import type { AuthUser, TokenVerifier } from "./verify-token.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by `authenticate`; identity always comes from the verified token, never the client. */
    user: AuthUser | null;
    /**
     * The verified bearer token. Forwarded to Supabase Storage so file access is checked against
     * the student's own storage policies. Never logged, stored or sent anywhere else.
     */
    accessToken: string | null;
    /** The account's role, read from the database on this request (null when no access check is configured). Never from the client. */
    role: Role | null;
  }
}

/**
 * Builds a preHandler that requires `Authorization: Bearer <supabase access token>`.
 * With an access repository it also looks the account up in the database on every request: a paused (revoked) account is
 * refused with 403 immediately, and the role used by `requireAdmin` comes from that same lookup.
 */
export function createAuthenticate(verify: TokenVerifier, access?: AccessRepository) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const token = match?.[1];
    const user = token ? await verify(token) : null;
    if (!user || !token) {
      return reply.status(401).send({ error: "unauthorized", message: "Sign in to continue." });
    }
    if (access) {
      // A failed lookup is an error (500), not a pass: if we cannot tell whether the account is paused, we do not let it in.
      const record = await access.get(user.id);
      if (record?.accessStatus === "revoked") {
        return reply.status(403).send({ error: ACCESS_REVOKED_CODE, message: ACCESS_REVOKED_MESSAGE });
      }
      req.role = record?.role ?? "student";
    }
    req.user = user;
    req.accessToken = token;
  };
}

/** Passes only for an administrator (role from the database lookup in `authenticate`). Everyone else gets 403. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.role !== "admin") {
    return reply.status(403).send({ error: "forbidden", message: "This area is for administrators only." });
  }
}
