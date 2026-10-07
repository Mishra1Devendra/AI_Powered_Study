import {
  STUDY_TOOLS_LIMITS,
  type CardInput,
  type CardGrade,
  type Deck,
  type DeckDetailResponse,
  type DeckListResponse,
  type Flashcard,
  type GenerateDeckInput,
  type GenerateMindmapInput,
  type Mindmap,
  type MindmapSize,
  type StudyQueueResponse,
  type StudySource,
  type UpdateCardInput,
} from "@copilot/shared";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { NotesRepository } from "../notes/repository.js";
import type { LLMProvider } from "../services/ai/index.js";
import { generateFlashcards, generateMindmap, StudyGenerationError } from "./generate.js";
import type { CardRecord, DeckCounts, DeckRecord, MapRecord, StudyToolsRepository } from "./repository.js";
import { cardState, previewDays, schedule } from "./srs.js";

/** The whole writing job is cut off after this long, so a stuck model can never hold a student. */
export const STUDY_JOB_DEADLINE_MS = 10 * 60_000;
/** Writing jobs one student may have running at once (each is one AI call). */
const MAX_RUNNING_PER_USER = 2;
const LIST_LIMIT = 100;

export interface StudyToolsDeps {
  repo: StudyToolsRepository;
  notes: NotesRepository;
  ai: LLMProvider;
  now?: () => Date;
  rng?: () => number;
  jobDeadlineMs?: number;
  onError?: (err: unknown) => void;
}

export function createStudyToolsService(deps: StudyToolsDeps) {
  const { repo, notes, ai } = deps;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? (() => undefined);
  /** Deck/map id -> the job writing it in THIS process. */
  const running = new Map<string, { userId: string; job: Promise<void> }>();

  const runningFor = (userId: string) => [...running.values()].filter((r) => r.userId === userId).length;
  const runningIds = () => [...running.keys()];

  function deckDto(d: DeckRecord, c?: DeckCounts): Deck {
    return {
      id: d.id,
      title: d.title,
      sourceType: d.sourceType,
      status: d.status,
      error: d.status === "error" ? (d.error ?? "The cards could not be created. Please try again.") : null,
      isMock: d.isMock,
      cardCount: c?.cardCount ?? 0,
      dueCount: c?.dueCount ?? 0,
      newCount: c?.newCount ?? 0,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  function cardDto(c: CardRecord): Flashcard {
    return {
      id: c.id,
      deckId: c.deckId,
      front: c.front,
      back: c.back,
      hint: c.hint,
      state: cardState(c),
      dueAt: c.dueAt.toISOString(),
      intervalDays: c.intervalDays,
      repetitions: c.repetitions,
      lapses: c.lapses,
      nextDays: previewDays(c, now()),
    };
  }

  function mapDto(m: MapRecord, withTree: boolean): Mindmap {
    return {
      id: m.id,
      title: m.title,
      sourceType: m.sourceType,
      size: m.size,
      status: m.status,
      error: m.status === "error" ? (m.error ?? "The mind map could not be created. Please try again.") : null,
      isMock: m.isMock,
      nodeCount: m.nodeCount,
      tree: withTree && m.status === "ready" ? m.tree : null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** The note ids in a source must be this student's own, ready notes (a quick, no-AI check before anything is started). */
  async function checkSource(userId: string, source: StudySource) {
    if (source.type !== "notes") return;
    for (const id of new Set(source.documentIds)) {
      const doc = await notes.getNote(userId, id); // scoped to this student: someone else's note is indistinguishable from a missing one
      if (!doc) throw new NotFoundError("One of the selected notes was not found.");
      if (doc.status !== "ready") throw new BadRequestError("One of the selected notes is not ready yet.");
    }
  }

  /** Jobs in flight per student: a double click must not use the free AI quota twice. (The daily allowance is charged by the route, and administrators have none.) */
  async function checkQuota(userId: string) {
    if (runningFor(userId) >= MAX_RUNNING_PER_USER) throw new ConflictError("Two are already being created. Wait for one to finish.");
  }

  function track(id: string, userId: string, work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), deps.jobDeadlineMs ?? STUDY_JOB_DEADLINE_MS);
    const job = work(controller.signal).finally(() => {
      clearTimeout(deadline);
      running.delete(id);
    });
    running.set(id, { userId, job });
  }

  const failure = (e: unknown) => {
    const known = e instanceof StudyGenerationError;
    if (!known) onError(e);
    return known ? e.message : "Something went wrong while creating this. Please try again.";
  };
  const meta = () => ({ provider: ai.name, model: ai.model, isMock: ai.isMock });

  async function reap(userId: string) {
    const older = new Date(now().getTime() - (deps.jobDeadlineMs ?? STUDY_JOB_DEADLINE_MS) - 2 * 60_000);
    await Promise.all([repo.failStaleDecks(userId, older, runningIds()), repo.failStaleMaps(userId, older, runningIds())]);
  }

  async function ownedDeck(userId: string, id: string): Promise<DeckRecord> {
    const d = await repo.getDeck(userId, id);
    if (!d) throw new NotFoundError("Deck not found.");
    return d;
  }

  async function deckWithCounts(d: DeckRecord): Promise<Deck> {
    const counts = await repo.deckCounts(d.userId, [d.id], now());
    return deckDto(d, counts.get(d.id));
  }

  async function startMap(userId: string, source: StudySource, size: MindmapSize, placeholder: string, titleOverride?: string): Promise<Mindmap> {
    const map = await repo.createMap(userId, { title: placeholder.slice(0, STUDY_TOOLS_LIMITS.titleMaxChars), source, size });
    track(map.id, userId, async (signal) => {
      try {
        const out = await generateMindmap({ ai, notes, rng: deps.rng ?? Math.random, signal }, userId, source, size, titleOverride);
        const ok = await repo.setMapReady(userId, map.id, { tree: out.tree, nodeCount: out.nodeCount, title: out.title }, { provider: out.provider, model: out.model, isMock: out.isMock });
        if (!ok) onError(new Error("mind map was no longer generating when it was ready"));
      } catch (e) {
        await repo.setMapError(userId, map.id, failure(e), meta()).catch(onError);
      }
    });
    return mapDto(map, false);
  }
  return {
    /* ------------------------------------------- flashcards ------------------------------------------- */

    /** Starts writing a deck. Returns at once (status "generating"); the client polls `getDeck` until it is ready. */
    async generateDeck(userId: string, input: GenerateDeckInput): Promise<Deck> {
      await reap(userId);
      if ((await repo.countDecks(userId)) >= STUDY_TOOLS_LIMITS.maxDecks) throw new AppError(409, "too_many_decks", "You have the maximum number of decks. Delete one first.");
      await checkSource(userId, input.source);
      await checkQuota(userId);
      const placeholder = input.title?.trim() || (input.source.type === "topic" ? input.source.subject : "New deck");
      const deck = await repo.createDeck(userId, { title: placeholder.slice(0, STUDY_TOOLS_LIMITS.titleMaxChars), sourceType: input.source.type, status: "generating" });
      track(deck.id, userId, async (signal) => {
        try {
          const out = await generateFlashcards({ ai, notes, rng: deps.rng ?? Math.random, signal }, userId, input.source, input.count);
          const title = (input.title?.trim() || out.title).slice(0, STUDY_TOOLS_LIMITS.titleMaxChars);
          const ok = await repo.setDeckReady(userId, deck.id, out.cards, title, { provider: out.provider, model: out.model, isMock: out.isMock });
          if (!ok) onError(new Error("flashcard deck was no longer generating when its cards were ready"));
        } catch (e) {
          await repo.setDeckError(userId, deck.id, failure(e), meta()).catch(onError);
        }
      });
      return deckDto(deck);
    },

    /** An empty deck the student fills in by hand (no AI, no quota). */
    async createDeck(userId: string, title: string): Promise<Deck> {
      if ((await repo.countDecks(userId)) >= STUDY_TOOLS_LIMITS.maxDecks) throw new AppError(409, "too_many_decks", "You have the maximum number of decks. Delete one first.");
      return deckDto(await repo.createDeck(userId, { title, sourceType: "manual", status: "ready" }));
    },

    async listDecks(userId: string): Promise<DeckListResponse> {
      await reap(userId);
      const day = now();
      const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
      const [decks, summary] = await Promise.all([repo.listDecks(userId, LIST_LIMIT), repo.summary(userId, day, dayStart)]);
      const counts = await repo.deckCounts(userId, decks.map((d) => d.id), day);
      return { decks: decks.map((d) => deckDto(d, counts.get(d.id))), dueTotal: summary.dueTotal, reviewedToday: summary.reviewedToday };
    },

    async getDeck(userId: string, id: string): Promise<DeckDetailResponse> {
      await reap(userId);
      const d = await ownedDeck(userId, id);
      const [deck, cards] = await Promise.all([deckWithCounts(d), repo.listCards(userId, id)]);
      return { deck, cards: cards.map(cardDto) };
    },

    async renameDeck(userId: string, id: string, title: string): Promise<Deck> {
      const d = await repo.renameDeck(userId, id, title);
      if (!d) throw new NotFoundError("Deck not found.");
      return deckWithCounts(d);
    },

    async deleteDeck(userId: string, id: string): Promise<void> {
      if (!(await repo.deleteDeck(userId, id))) throw new NotFoundError("Deck not found.");
    },

    async addCard(userId: string, deckId: string, input: CardInput): Promise<Flashcard> {
      const deck = await ownedDeck(userId, deckId);
      if (deck.status === "generating") throw new ConflictError("This deck is still being written.");
      if ((await repo.countCards(userId, deckId)) >= STUDY_TOOLS_LIMITS.maxCardsPerDeck) throw new AppError(409, "too_many_cards", `A deck can hold ${STUDY_TOOLS_LIMITS.maxCardsPerDeck} cards.`);
      const card = await repo.addCard(userId, deckId, { front: input.front, back: input.back, hint: input.hint?.trim() || null });
      if (!card) throw new NotFoundError("Deck not found.");
      return cardDto(card);
    },

    async updateCard(userId: string, cardId: string, input: UpdateCardInput): Promise<Flashcard> {
      const patch: { front?: string; back?: string; hint?: string | null } = {};
      if (input.front !== undefined) patch.front = input.front;
      if (input.back !== undefined) patch.back = input.back;
      if (input.hint !== undefined) patch.hint = input.hint.trim() || null;
      const card = await repo.updateCard(userId, cardId, patch);
      if (!card) throw new NotFoundError("Card not found.");
      return cardDto(card);
    },

    async deleteCard(userId: string, cardId: string): Promise<void> {
      if (!(await repo.deleteCard(userId, cardId))) throw new NotFoundError("Card not found.");
    },

    /** Due cards first, then new ones, at most one short round. */
    async studyQueue(userId: string, deckId: string): Promise<StudyQueueResponse> {
      const d = await ownedDeck(userId, deckId);
      if (d.status !== "ready") throw new ConflictError(d.status === "generating" ? "This deck is still being written." : "This deck has no cards to study.");
      const when = now();
      const [cards, counts] = await Promise.all([repo.studyCards(userId, deckId, when, STUDY_TOOLS_LIMITS.studyBatch), repo.deckCounts(userId, [deckId], when)]);
      const c = counts.get(deckId);
      return { deck: deckDto(d, c), cards: cards.map(cardDto), remaining: Math.max(0, (c?.dueCount ?? 0) + (c?.newCount ?? 0) - cards.length) };
    },

    /** The server decides when the card comes back; the client only says how well it was remembered. */
    async review(userId: string, cardId: string, grade: CardGrade): Promise<Flashcard> {
      const card = await repo.getCard(userId, cardId);
      if (!card) throw new NotFoundError("Card not found.");
      const when = now();
      const saved = await repo.saveReview(userId, cardId, schedule(card, grade, when), when);
      if (!saved) throw new NotFoundError("Card not found.");
      return cardDto(saved);
    },

    /* ------------------------------------------- mind maps ------------------------------------------- */

    async generateMindmap(userId: string, input: GenerateMindmapInput): Promise<Mindmap> {
      await reap(userId);
      if ((await repo.countMaps(userId)) >= STUDY_TOOLS_LIMITS.maxMindmaps) throw new AppError(409, "too_many_mindmaps", "You have the maximum number of mind maps. Delete one first.");
      await checkSource(userId, input.source);
      await checkQuota(userId);
      return startMap(userId, input.source, input.size, input.title?.trim() || (input.source.type === "topic" ? input.source.subject : "New mind map"), input.title?.trim());
    },

    async listMindmaps(userId: string): Promise<Mindmap[]> {
      await reap(userId);
      return (await repo.listMaps(userId, LIST_LIMIT)).map((m) => mapDto(m, false));
    },

    async getMindmap(userId: string, id: string): Promise<Mindmap> {
      await reap(userId);
      const m = await repo.getMap(userId, id);
      if (!m) throw new NotFoundError("Mind map not found.");
      return mapDto(m, true);
    },

    async renameMindmap(userId: string, id: string, title: string): Promise<Mindmap> {
      const m = await repo.renameMap(userId, id, title);
      if (!m) throw new NotFoundError("Mind map not found.");
      return mapDto(m, true);
    },

    async deleteMindmap(userId: string, id: string): Promise<void> {
      if (!(await repo.deleteMap(userId, id))) throw new NotFoundError("Mind map not found.");
    },

    /** A new map from the same notes or topic (a different arrangement); the old one is kept. */
    async regenerateMindmap(userId: string, id: string): Promise<Mindmap> {
      await reap(userId);
      const old = await repo.getMap(userId, id);
      if (!old) throw new NotFoundError("Mind map not found.");
      if ((await repo.countMaps(userId)) >= STUDY_TOOLS_LIMITS.maxMindmaps) throw new AppError(409, "too_many_mindmaps", "You have the maximum number of mind maps. Delete one first.");
      await checkSource(userId, old.source);
      await checkQuota(userId);
      return startMap(userId, old.source, old.size, old.title, old.title);
    },

    /** Test hook: resolves when every job started in this process has finished. */
    async idle(): Promise<void> {
      await Promise.all([...running.values()].map((r) => r.job.catch(() => undefined)));
    },
  };

}

export type StudyToolsService = ReturnType<typeof createStudyToolsService>;
