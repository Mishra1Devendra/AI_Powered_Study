import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { generateQuizInputSchema, quizIdParamSchema, saveAnswersInputSchema, submitAttemptInputSchema } from "@copilot/shared";
import type { QuizService } from "../quiz/service.js";

interface Deps {
  service: QuizService;
  authenticate: preHandlerAsyncHookHandler;
}

/** Generating a quiz keeps the local model busy for a while: a tight per-client cap. */
const GENERATE_RATE_LIMIT = { max: 6, timeWindow: "1 minute" } as const;
/** Autosave is chatty by design (one call per answer), so it gets more room. */
const ANSWER_RATE_LIMIT = { max: 240, timeWindow: "1 minute" } as const;
const BODY_LIMIT = 16 * 1024;

/**
 * Every route authenticates, resolves the student from the verified token, and loads each quiz /
 * attempt through that student's identity: someone else's id is indistinguishable from a missing
 * one (404). Ids from the browser are never trusted to identify an owner.
 */
export async function quizRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  const base = "/api/quiz";

  app.get(`${base}/options`, { preHandler: authenticate }, async (req) => service.options(req.user!.id));

  app.post(`${base}/generate`, { preHandler: [authenticate, app.aiQuota.guard("quiz")], bodyLimit: BODY_LIMIT, config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const input = generateQuizInputSchema.parse(req.body);
    const quiz = await service.generate(req.user!.id, input);
    return reply.status(202).send({ quiz });
  });

  app.get(base, { preHandler: authenticate }, async (req) => service.list(req.user!.id));

  app.get(`${base}/attempts`, { preHandler: authenticate }, async (req) => ({ attempts: await service.history(req.user!.id) }));

  app.get(`${base}/attempts/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.attemptView(req.user!.id, id);
  });

  app.put(`${base}/attempts/:id/answers`, { preHandler: authenticate, bodyLimit: BODY_LIMIT, config: { rateLimit: ANSWER_RATE_LIMIT } }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.saveAnswers(req.user!.id, id, saveAnswersInputSchema.parse(req.body));
  });

  app.post(`${base}/attempts/:id/submit`, { preHandler: authenticate, bodyLimit: BODY_LIMIT }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.submit(req.user!.id, id, submitAttemptInputSchema.parse(req.body ?? {}));
  });

  app.get(`${base}/attempts/:id/result`, { preHandler: authenticate }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.result(req.user!.id, id);
  });

  app.get(`${base}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.detail(req.user!.id, id);
  });

  app.post(`${base}/:id/start`, { preHandler: authenticate }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.start(req.user!.id, id);
  });

  app.post(`${base}/:id/retry`, { preHandler: authenticate }, async (req) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return service.retry(req.user!.id, id);
  });

  app.post(`${base}/:id/regenerate`, { preHandler: [authenticate, app.aiQuota.guard("quiz")], config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const { id } = quizIdParamSchema.parse(req.params);
    return reply.status(202).send({ quiz: await service.regenerate(req.user!.id, id) });
  });
}
