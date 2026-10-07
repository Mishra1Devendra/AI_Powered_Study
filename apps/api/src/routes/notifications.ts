import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { NotificationService } from "../notifications/service.js";

interface Deps {
  service: NotificationService;
  authenticate: preHandlerAsyncHookHandler;
}

const LIMIT = { max: 30, timeWindow: "1 minute" } as const;

/** `GET /api/notifications` - what needs attention, from the signed-in student's own records (no AI, nothing stored). */
export async function notificationRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  app.get("/api/notifications", { preHandler: authenticate, config: { rateLimit: LIMIT } }, async (req) => service.list(req.user!.id));
}
