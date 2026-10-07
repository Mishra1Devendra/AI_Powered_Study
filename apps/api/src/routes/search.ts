import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { searchQuerySchema } from "@copilot/shared";
import type { SearchRepository } from "../search/repository.js";

interface Deps {
  repo: SearchRepository;
  authenticate: preHandlerAsyncHookHandler;
}

/** Typing is cheap for the database but not free: a per-client cap, well above normal typing speed. */
const SEARCH_LIMIT = { max: 90, timeWindow: "1 minute" } as const;

/** `GET /api/search?q=` - the student's own documents, quizzes, plans, tutor chats, subjects and topics. */
export async function searchRoutes(app: FastifyInstance, { repo, authenticate }: Deps) {
  app.get("/api/search", { preHandler: authenticate, config: { rateLimit: SEARCH_LIMIT } }, async (req) => {
    const { q } = searchQuerySchema.parse(req.query);
    // The student comes only from the verified token; there is no user id anywhere in the request.
    return repo.search(req.user!.id, q);
  });
}
