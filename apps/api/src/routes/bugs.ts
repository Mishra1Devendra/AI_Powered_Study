import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { createBugReportInputSchema, createBugReportResponseSchema } from "@copilot/shared";
import type { BugRepository } from "../bugs/repository.js";

/** Any signed-in (and not paused) account can report a bug. The reporter is always the verified user, never a body field. */
export async function bugRoutes(app: FastifyInstance, { repo, authenticate }: { repo: BugRepository; authenticate: preHandlerAsyncHookHandler }) {
  app.post("/api/bug-reports", { preHandler: authenticate, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = createBugReportInputSchema.parse(req.body);
    const { id } = await repo.create(req.user!.id, input);
    // Id only: the report text is never logged.
    req.log.info({ event: "bug_report_created", by: req.user!.id, id }, "bug report");
    return reply.status(201).send(createBugReportResponseSchema.parse({ id }));
  });
}
