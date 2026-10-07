import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { checkParamSchema, latestCheckResponseSchema, planIdParamSchema, planInputSchema, rescheduleInputSchema, sessionActionParamSchema, startCheckResponseSchema, submitCheckInputSchema, submitCheckResponseSchema, updatePlanSchema } from "@copilot/shared";
import type { CheckService } from "../planner/checks/service.js";
import type { PlannerService } from "../planner/service.js";

interface Deps {
  service: PlannerService;
  /** Study checks (5 questions before a session can be completed). Absent = the routes are not registered. */
  checks?: CheckService | undefined;
  authenticate: preHandlerAsyncHookHandler;
}

/** Creating a plan keeps the local model busy for a while: a tight per-client cap. */
const GENERATE_RATE_LIMIT = { max: 4, timeWindow: "1 minute" } as const;
const ACTION_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;
const BODY_LIMIT = 16 * 1024;

/**
 * Every route authenticates and resolves the student from the verified token. Plans and sessions are
 * always loaded through that student's identity: someone else's id behaves exactly like a missing one (404).
 */
export async function plannerRoutes(app: FastifyInstance, { service, checks, authenticate }: Deps) {
  const base = "/api/study-plans";

  app.get(`${base}/options`, { preHandler: authenticate }, async (req) => service.options(req.user!.id));

  app.post(`${base}/generate`, { preHandler: [authenticate, app.aiQuota.guard("planner")], bodyLimit: BODY_LIMIT, config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const plan = await service.generate(req.user!.id, planInputSchema.parse(req.body));
    return reply.status(202).send({ plan });
  });

  app.get(base, { preHandler: authenticate }, async (req) => service.list(req.user!.id));

  app.get(`${base}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = planIdParamSchema.parse(req.params);
    return service.detail(req.user!.id, id);
  });

  app.patch(`${base}/:id`, { preHandler: authenticate, bodyLimit: BODY_LIMIT }, async (req) => {
    const { id } = planIdParamSchema.parse(req.params);
    return { plan: await service.update(req.user!.id, id, updatePlanSchema.parse(req.body)) };
  });

  app.post(`${base}/:id/regenerate`, { preHandler: [authenticate, app.aiQuota.guard("planner")], bodyLimit: BODY_LIMIT, config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const { id } = planIdParamSchema.parse(req.params);
    const plan = await service.regenerate(req.user!.id, id);
    return reply.status(202).send({ plan });
  });

  app.post(`${base}/:id/activate`, { preHandler: authenticate, bodyLimit: BODY_LIMIT }, async (req) => {
    const { id } = planIdParamSchema.parse(req.params);
    return { plan: await service.activate(req.user!.id, id) };
  });

  if (checks) {
    // Starting a check keeps the local model busy: the same tight cap as creating a plan. Polling is a plain read.
    app.post("/api/study-sessions/:id/check", { preHandler: [authenticate, app.aiQuota.guard("check")], bodyLimit: BODY_LIMIT, config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
      const { id } = planIdParamSchema.parse(req.params);
      // Administrators have no per-session cap either. An existing set is returned without asking the AI again, so it costs nothing.
      const { check, created } = await checks.startReporting(req.user!.id, id, { unlimited: req.role === "admin" });
      if (!created) await app.aiQuota.refund(req);
      return reply.status(check.status === "generating" ? 202 : 200).send(startCheckResponseSchema.parse({ check }));
    });

    app.get("/api/study-sessions/:id/check", { preHandler: authenticate }, async (req) => {
      const { id } = planIdParamSchema.parse(req.params);
      return latestCheckResponseSchema.parse({ check: await checks.latest(req.user!.id, id) });
    });

    app.post("/api/study-sessions/:id/check/:checkId/answers", { preHandler: authenticate, bodyLimit: BODY_LIMIT, config: { rateLimit: ACTION_RATE_LIMIT } }, async (req) => {
      const { id, checkId } = checkParamSchema.parse(req.params);
      const input = submitCheckInputSchema.parse(req.body);
      return submitCheckResponseSchema.parse(await checks.submit(req.user!.id, id, checkId, input));
    });
  }

  app.post("/api/study-sessions/:id/:action", { preHandler: authenticate, bodyLimit: BODY_LIMIT, config: { rateLimit: ACTION_RATE_LIMIT } }, async (req) => {
    const { id, action } = sessionActionParamSchema.parse(req.params);
    const body = action === "reschedule" ? rescheduleInputSchema.parse(req.body ?? {}) : {};
    return service.sessionAction(req.user!.id, id, action, body);
  });
}
