import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  cardInputSchema,
  cardResponseSchema,
  createDeckInputSchema,
  deckDetailResponseSchema,
  deckListResponseSchema,
  deckResponseSchema,
  generateDeckInputSchema,
  generateMindmapInputSchema,
  idParamSchema,
  mindmapListResponseSchema,
  mindmapResponseSchema,
  renameInputSchema,
  reviewInputSchema,
  reviewResponseSchema,
  studyQueueResponseSchema,
  updateCardInputSchema,
} from "@copilot/shared";
import type { StudyToolsService } from "../study-tools/service.js";

interface Deps {
  service: StudyToolsService;
  authenticate: preHandlerAsyncHookHandler;
}

/** Writing a deck or a map keeps the AI busy: a tight per-client cap (the service also caps them per day). */
const GENERATE_RATE_LIMIT = { max: 6, timeWindow: "1 minute" } as const;
/** Reviewing is one tap per card, so it gets more room. */
const REVIEW_RATE_LIMIT = { max: 240, timeWindow: "1 minute" } as const;
const BODY_LIMIT = 16 * 1024;

/**
 * Every route authenticates and resolves the student from the verified token; ids from the browser are never trusted to identify an
 * owner (someone else's deck, card or map is indistinguishable from a missing one: 404).
 */
export async function studyToolsRoutes(app: FastifyInstance, { service, authenticate }: Deps) {
  const fc = "/api/flashcards";
  const mm = "/api/mindmaps";
  const guard = { preHandler: authenticate, bodyLimit: BODY_LIMIT } as const;
  /** The same, plus the daily AI allowance for the feature (administrators are never limited). */
  const aiGuard = (feature: "flashcards" | "mindmap") => ({ preHandler: [authenticate, app.aiQuota.guard(feature)], bodyLimit: BODY_LIMIT });

  /* ---------------------------------------------- flashcards ---------------------------------------------- */

  app.get(`${fc}/decks`, { preHandler: authenticate }, async (req) => deckListResponseSchema.parse(await service.listDecks(req.user!.id)));

  app.post(`${fc}/decks/generate`, { ...aiGuard("flashcards"), config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const input = generateDeckInputSchema.parse(req.body);
    return reply.status(202).send(deckResponseSchema.parse({ deck: await service.generateDeck(req.user!.id, input) }));
  });

  app.post(`${fc}/decks`, guard, async (req, reply) => {
    const { title } = createDeckInputSchema.parse(req.body);
    return reply.status(201).send(deckResponseSchema.parse({ deck: await service.createDeck(req.user!.id, title) }));
  });

  app.get(`${fc}/decks/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return deckDetailResponseSchema.parse(await service.getDeck(req.user!.id, id));
  });

  app.patch(`${fc}/decks/:id`, guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { title } = renameInputSchema.parse(req.body);
    return deckResponseSchema.parse({ deck: await service.renameDeck(req.user!.id, id, title) });
  });

  app.delete(`${fc}/decks/:id`, { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await service.deleteDeck(req.user!.id, id);
    return reply.status(204).send();
  });

  app.post(`${fc}/decks/:id/cards`, guard, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const input = cardInputSchema.parse(req.body);
    return reply.status(201).send(cardResponseSchema.parse({ card: await service.addCard(req.user!.id, id, input) }));
  });

  app.get(`${fc}/decks/:id/study`, { preHandler: authenticate }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return studyQueueResponseSchema.parse(await service.studyQueue(req.user!.id, id));
  });

  app.patch(`${fc}/cards/:id`, guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const input = updateCardInputSchema.parse(req.body);
    return cardResponseSchema.parse({ card: await service.updateCard(req.user!.id, id, input) });
  });

  app.delete(`${fc}/cards/:id`, { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await service.deleteCard(req.user!.id, id);
    return reply.status(204).send();
  });

  app.post(`${fc}/cards/:id/review`, { ...guard, config: { rateLimit: REVIEW_RATE_LIMIT } }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { grade } = reviewInputSchema.parse(req.body);
    return reviewResponseSchema.parse({ card: await service.review(req.user!.id, id, grade) });
  });

  /* ---------------------------------------------- mind maps ---------------------------------------------- */

  app.post(`${mm}/generate`, { ...aiGuard("mindmap"), config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const input = generateMindmapInputSchema.parse(req.body);
    return reply.status(202).send(mindmapResponseSchema.parse({ mindmap: await service.generateMindmap(req.user!.id, input) }));
  });

  app.get(mm, { preHandler: authenticate }, async (req) => mindmapListResponseSchema.parse({ mindmaps: await service.listMindmaps(req.user!.id) }));

  app.get(`${mm}/:id`, { preHandler: authenticate }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return mindmapResponseSchema.parse({ mindmap: await service.getMindmap(req.user!.id, id) });
  });

  app.patch(`${mm}/:id`, guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { title } = renameInputSchema.parse(req.body);
    return mindmapResponseSchema.parse({ mindmap: await service.renameMindmap(req.user!.id, id, title) });
  });

  app.delete(`${mm}/:id`, { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    await service.deleteMindmap(req.user!.id, id);
    return reply.status(204).send();
  });

  app.post(`${mm}/:id/regenerate`, { ...aiGuard("mindmap"), config: { rateLimit: GENERATE_RATE_LIMIT } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.status(202).send(mindmapResponseSchema.parse({ mindmap: await service.regenerateMindmap(req.user!.id, id) }));
  });
}
