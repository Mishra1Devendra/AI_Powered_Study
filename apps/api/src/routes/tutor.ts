import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  conversationIdParamSchema,
  createConversationInputSchema,
  sendMessageInputSchema,
  updateConversationInputSchema,
} from "@copilot/shared";
import type { TutorService } from "../tutor/service.js";
import { GENERATION_RATE_LIMIT, streamTurn } from "./sse.js";

interface Deps {
  service: TutorService;
  authenticate: preHandlerAsyncHookHandler;
}

/** A message is at most 4,000 characters; nothing near this size is legitimate. */
const MESSAGE_BODY_LIMIT = 16 * 1024;

export async function tutorRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  const base = "/api/tutor/conversations";

  app.post(base, { preHandler: authenticate }, async (req, reply) => {
    const ctx = createConversationInputSchema.parse(req.body ?? {});
    const conversation = await service.createConversation(req.user!.id, ctx);
    return reply.status(201).send({ conversation });
  });

  app.get(base, { preHandler: authenticate }, async (req) => ({
    conversations: await service.listConversations(req.user!.id),
  }));

  app.get(`${base}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = conversationIdParamSchema.parse(req.params);
    return service.getConversationDetail(req.user!.id, id);
  });

  app.patch(`${base}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = conversationIdParamSchema.parse(req.params);
    const patch = updateConversationInputSchema.parse(req.body ?? {});
    return { conversation: await service.updateConversation(req.user!.id, id, patch) };
  });

  // Soft delete: hides the conversation from the student; no rows are removed.
  app.delete(`${base}/:id`, { preHandler: authenticate }, async (req, reply) => {
    const { id } = conversationIdParamSchema.parse(req.params);
    await service.deleteConversation(req.user!.id, id);
    return reply.status(204).send();
  });

  app.post(
    `${base}/:id/messages`,
    { preHandler: [authenticate, app.aiQuota.guard("tutor")], bodyLimit: MESSAGE_BODY_LIMIT, config: { rateLimit: GENERATION_RATE_LIMIT } },
    async (req, reply) => {
      const { id } = conversationIdParamSchema.parse(req.params);
      const input = sendMessageInputSchema.parse(req.body);
      const turn = await service.startSend(req.user!.id, id, input);
      await streamTurn(req, reply, turn);
    },
  );

  app.post(
    `${base}/:id/regenerate`,
    { preHandler: [authenticate, app.aiQuota.guard("tutor")], bodyLimit: 1024, config: { rateLimit: GENERATION_RATE_LIMIT } },
    async (req, reply) => {
      const { id } = conversationIdParamSchema.parse(req.params);
      const turn = await service.startRegenerate(req.user!.id, id);
      await streamTurn(req, reply, turn);
    },
  );
}
