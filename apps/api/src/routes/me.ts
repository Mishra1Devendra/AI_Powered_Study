import { eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { aiUsageSchema, meResponseSchema, updateProfileInputSchema, type MeResponse } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { studentProfiles } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";

interface Deps {
  db: Database;
  authenticate: preHandlerAsyncHookHandler;
}

const columns = {
  id: studentProfiles.id,
  displayName: studentProfiles.displayName,
  timezone: studentProfiles.timezone,
  role: studentProfiles.role,
};

export async function meRoutes(app: FastifyInstance, { db, authenticate }: Deps) {
  app.get("/api/me", { preHandler: authenticate }, async (req, reply): Promise<MeResponse> => {
    const user = req.user!;
    // No id filter from the client exists anywhere: RLS + the verified token decide the row.
    const [profile] = await withUser(db, user.id, (tx) =>
      tx.select(columns).from(studentProfiles).where(eq(studentProfiles.id, user.id)),
    );
    if (!profile) return reply.status(404).send({ error: "profile_not_found", message: "Profile not found." });
    return meResponseSchema.parse({ user, profile });
  });

  // How much of today's AI allowance is left (administrators: unlimited). Read-only; nothing is charged by asking.
  app.get("/api/me/ai-usage", { preHandler: authenticate }, async (req) => aiUsageSchema.parse(await app.aiQuota.usage(req.user!.id, req.role)));

  app.patch("/api/me/profile", { preHandler: authenticate }, async (req, reply) => {
    const user = req.user!;
    const input = updateProfileInputSchema.parse(req.body);
    const [profile] = await withUser(db, user.id, (tx) =>
      tx
        .update(studentProfiles)
        .set(input)
        .where(eq(studentProfiles.id, user.id))
        .returning(columns),
    );
    if (!profile) return reply.status(404).send({ error: "profile_not_found", message: "Profile not found." });
    return { profile };
  });
}
