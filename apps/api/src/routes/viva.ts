import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { answerVivaInputSchema, createVivaInputSchema, vivaIdParamSchema } from "@copilot/shared";
import type { VivaService } from "../viva/service.js";

interface Deps {
  service: VivaService;
  authenticate: preHandlerAsyncHookHandler;
}

/** Each of these keeps the local model busy for a while: tight per-client caps. */
const CREATE_LIMIT = { max: 6, timeWindow: "1 minute" } as const;
const STEP_LIMIT = { max: 20, timeWindow: "1 minute" } as const;
const BODY_LIMIT = 16 * 1024;

/**
 * Every route authenticates and resolves the student from the verified token. A viva is always loaded through that
 * student's identity: someone else's id behaves exactly like a missing one (404), and a question is only ever
 * reached through its own viva. There is no user id anywhere in a request.
 */
export async function vivaRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  const base = "/api/viva";

  app.get(`${base}/options`, { preHandler: authenticate }, async (req) => service.options(req.user!.id));

  app.post(`${base}/sessions`, { preHandler: [authenticate, app.aiQuota.guard("viva")], bodyLimit: BODY_LIMIT, config: { rateLimit: CREATE_LIMIT } }, async (req, reply) => {
    const input = createVivaInputSchema.parse(req.body);
    return reply.status(201).send(await service.create(req.user!.id, input));
  });

  app.get(`${base}/sessions`, { preHandler: authenticate }, async (req) => service.list(req.user!.id));

  app.get(`${base}/sessions/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = vivaIdParamSchema.parse(req.params);
    return service.detail(req.user!.id, id);
  });

  app.post(`${base}/sessions/:id/answer`, { preHandler: [authenticate, app.aiQuota.guard("viva")], bodyLimit: BODY_LIMIT, config: { rateLimit: STEP_LIMIT } }, async (req) => {
    const { id } = vivaIdParamSchema.parse(req.params);
    return service.answer(req.user!.id, id, answerVivaInputSchema.parse(req.body));
  });

  app.post(`${base}/sessions/:id/next`, { preHandler: [authenticate, app.aiQuota.guard("viva")], bodyLimit: BODY_LIMIT, config: { rateLimit: STEP_LIMIT } }, async (req) => {
    const { id } = vivaIdParamSchema.parse(req.params);
    return service.next(req.user!.id, id);
  });

  app.post(`${base}/sessions/:id/abandon`, { preHandler: authenticate, bodyLimit: BODY_LIMIT }, async (req) => {
    const { id } = vivaIdParamSchema.parse(req.params);
    return service.abandon(req.user!.id, id);
  });
}
