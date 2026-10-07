import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { progressQuerySchema } from "@copilot/shared";
import type { ProgressService } from "../progress/service.js";

interface Deps {
  service: ProgressService;
  authenticate: preHandlerAsyncHookHandler;
}

/** One request per view of the page; a generous-but-bounded cap protects the database. */
const RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

/**
 * Read-only. The student is resolved from the verified token; there is no user id (or any other identity)
 * in the request, so there is nothing a client could change to see someone else's numbers. The range is
 * checked against a fixed list (an unknown value is a 400, never passed to the database).
 */
export async function progressRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  app.get("/api/progress/summary", { preHandler: authenticate, config: { rateLimit: RATE_LIMIT } }, async (req) => {
    const { range } = progressQuerySchema.parse(req.query);
    return service.summary(req.user!.id, range);
  });
}
