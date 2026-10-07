import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { recommendationsQuerySchema } from "@copilot/shared";
import type { RecommendationService } from "../recommendations/service.js";

interface Deps {
  service: RecommendationService;
  authenticate: preHandlerAsyncHookHandler;
}

const LIST_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
/** Each explanation keeps the local model busy for a while: a tight per-client cap. */
const EXPLAIN_LIMIT = { max: 6, timeWindow: "1 minute" } as const;

/**
 * Read-only recommendations plus one optional AI wording call. The student comes only from the verified token: there is
 * no user id, topic or fact in a request that the server would believe (the explanation takes no body at all - the
 * server recomputes the facts itself). `limit` is validated (1-30); anything else is a 400.
 */
export async function recommendationRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  app.get("/api/recommendations", { preHandler: authenticate, config: { rateLimit: LIST_LIMIT } }, async (req) => {
    const { limit } = recommendationsQuerySchema.parse(req.query);
    return service.list(req.user!.id, limit);
  });

  app.post("/api/recommendations/explain", { preHandler: [authenticate, app.aiQuota.guard("recommendations")], config: { rateLimit: EXPLAIN_LIMIT }, bodyLimit: 1024 }, async (req) => service.explain(req.user!.id));
}
