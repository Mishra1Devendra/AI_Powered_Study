import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { MindmapNode, MindmapSize, StudySource } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { flashcardDecks, flashcards, mindmaps } from "../db/schema/index.js";
import type { Scheduled } from "./srs.js";

export type DeckStatus = "generating" | "ready" | "error";

export interface DeckRecord {
  id: string;
  userId: string;
  title: string;
  sourceType: "notes" | "topic" | "manual";
  status: DeckStatus;
  error: string | null;
  isMock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeckCounts {
  cardCount: number;
  /** Cards already seen that are due now. */
  dueCount: number;
  /** Cards never reviewed. */
  newCount: number;
}

export interface CardRecord {
  id: string;
  deckId: string;
  userId: string;
  front: string;
  back: string;
  hint: string | null;
  position: number;
  easeX100: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  dueAt: Date;
  lastReviewedAt: Date | null;
  createdAt: Date;
}

export interface NewCard {
  front: string;
  back: string;
  hint: string | null;
}

export interface GenerationMeta {
  provider: string;
  model: string;
  isMock: boolean;
}

export interface MapRecord {
  id: string;
  userId: string;
  title: string;
  sourceType: "notes" | "topic";
  source: StudySource;
  size: MindmapSize;
  status: DeckStatus;
  error: string | null;
  tree: MindmapNode | null;
  nodeCount: number;
  isMock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudyToolsRepository {
  /* decks */
  createDeck(userId: string, input: { title: string; sourceType: DeckRecord["sourceType"]; status: DeckStatus }): Promise<DeckRecord>;
  getDeck(userId: string, id: string): Promise<DeckRecord | null>;
  listDecks(userId: string, limit: number): Promise<DeckRecord[]>;
  countDecks(userId: string): Promise<number>;
  /** Card counts per deck id (decks with no cards are simply absent). */
  deckCounts(userId: string, deckIds: string[], now: Date): Promise<Map<string, DeckCounts>>;
  renameDeck(userId: string, id: string, title: string): Promise<DeckRecord | null>;
  deleteDeck(userId: string, id: string): Promise<boolean>;
  /** generating -> ready, and the cards are stored. False if the deck was no longer generating (deleted, or already failed). */
  setDeckReady(userId: string, id: string, cards: NewCard[], title: string, meta: GenerationMeta): Promise<boolean>;
  setDeckError(userId: string, id: string, error: string, meta?: GenerationMeta): Promise<void>;
  /** Marks generating decks that no job here is working on (a restart, a crash) as errored. */
  failStaleDecks(userId: string, olderThan: Date, keepIds: string[]): Promise<number>;

  /* cards */
  listCards(userId: string, deckId: string): Promise<CardRecord[]>;
  countCards(userId: string, deckId: string): Promise<number>;
  addCard(userId: string, deckId: string, card: NewCard): Promise<CardRecord | null>;
  getCard(userId: string, cardId: string): Promise<CardRecord | null>;
  updateCard(userId: string, cardId: string, patch: { front?: string; back?: string; hint?: string | null }): Promise<CardRecord | null>;
  deleteCard(userId: string, cardId: string): Promise<boolean>;
  /** Cards to study: due ones first (oldest due first), then new ones in deck order. */
  studyCards(userId: string, deckId: string, now: Date, limit: number): Promise<CardRecord[]>;
  saveReview(userId: string, cardId: string, next: Scheduled, now: Date): Promise<CardRecord | null>;
  summary(userId: string, now: Date, dayStart: Date): Promise<{ dueTotal: number; reviewedToday: number }>;

  /* mind maps */
  createMap(userId: string, input: { title: string; source: StudySource; size: MindmapSize }): Promise<MapRecord>;
  getMap(userId: string, id: string): Promise<MapRecord | null>;
  listMaps(userId: string, limit: number): Promise<MapRecord[]>;
  countMaps(userId: string): Promise<number>;
  renameMap(userId: string, id: string, title: string): Promise<MapRecord | null>;
  deleteMap(userId: string, id: string): Promise<boolean>;
  setMapReady(userId: string, id: string, result: { tree: MindmapNode; nodeCount: number; title: string }, meta: GenerationMeta): Promise<boolean>;
  setMapError(userId: string, id: string, error: string, meta?: GenerationMeta): Promise<void>;
  failStaleMaps(userId: string, olderThan: Date, keepIds: string[]): Promise<number>;

}

type DeckRow = typeof flashcardDecks.$inferSelect;
type CardRow = typeof flashcards.$inferSelect;
type MapRow = typeof mindmaps.$inferSelect;

const toDeck = (r: DeckRow): DeckRecord => ({
  id: r.id,
  userId: r.userId,
  title: r.title,
  sourceType: r.sourceType as DeckRecord["sourceType"],
  status: r.status as DeckStatus,
  error: r.error,
  isMock: r.isMock,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const toCard = (r: CardRow): CardRecord => ({
  id: r.id,
  deckId: r.deckId,
  userId: r.userId,
  front: r.front,
  back: r.back,
  hint: r.hint,
  position: r.position,
  easeX100: r.easeX100,
  intervalDays: r.intervalDays,
  repetitions: r.repetitions,
  lapses: r.lapses,
  dueAt: r.dueAt,
  lastReviewedAt: r.lastReviewedAt,
  createdAt: r.createdAt,
});
const toMap = (r: MapRow): MapRecord => ({
  id: r.id,
  userId: r.userId,
  title: r.title,
  sourceType: r.sourceType as MapRecord["sourceType"],
  source: r.source as StudySource,
  size: r.size as MindmapSize,
  status: r.status as DeckStatus,
  error: r.error,
  tree: (r.tree as MindmapNode | null) ?? null,
  nodeCount: r.nodeCount,
  isMock: r.isMock,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * Server-only: these tables have no client grants, so the repository uses the server's privileged connection. EVERY query is scoped
 * by the verified user id as well as the id asked for, so one student can never reach another's deck, card or map.
 */
export function createStudyToolsRepository(db: Database): StudyToolsRepository {
  const myDeck = (userId: string, id: string) => and(eq(flashcardDecks.userId, userId), eq(flashcardDecks.id, id));
  const myCard = (userId: string, id: string) => and(eq(flashcards.userId, userId), eq(flashcards.id, id));
  const myMap = (userId: string, id: string) => and(eq(mindmaps.userId, userId), eq(mindmaps.id, id));

  return {
    async createDeck(userId, input) {
      const [row] = await db.insert(flashcardDecks).values({ userId, title: input.title, sourceType: input.sourceType, status: input.status }).returning();
      return toDeck(row!);
    },
    async getDeck(userId, id) {
      const [row] = await db.select().from(flashcardDecks).where(myDeck(userId, id)).limit(1);
      return row ? toDeck(row) : null;
    },
    async listDecks(userId, limit) {
      const rows = await db.select().from(flashcardDecks).where(eq(flashcardDecks.userId, userId)).orderBy(desc(flashcardDecks.createdAt)).limit(limit);
      return rows.map(toDeck);
    },
    async countDecks(userId) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(flashcardDecks).where(eq(flashcardDecks.userId, userId));
      return row?.n ?? 0;
    },
    async deckCounts(userId, deckIds, now) {
      const out = new Map<string, DeckCounts>();
      if (deckIds.length === 0) return out;
      const rows = await db
        .select({
          deckId: flashcards.deckId,
          cardCount: sql<number>`count(*)::int`,
          dueCount: sql<number>`(count(*) filter (where ${flashcards.lastReviewedAt} is not null and ${flashcards.dueAt} <= ${now.toISOString()}::timestamptz))::int`,
          newCount: sql<number>`(count(*) filter (where ${flashcards.lastReviewedAt} is null))::int`,
        })
        .from(flashcards)
        .where(and(eq(flashcards.userId, userId), inArray(flashcards.deckId, deckIds)))
        .groupBy(flashcards.deckId);
      for (const r of rows) out.set(r.deckId, { cardCount: r.cardCount, dueCount: r.dueCount, newCount: r.newCount });
      return out;
    },
    async renameDeck(userId, id, title) {
      const [row] = await db.update(flashcardDecks).set({ title, updatedAt: new Date() }).where(myDeck(userId, id)).returning();
      return row ? toDeck(row) : null;
    },
    async deleteDeck(userId, id) {
      const rows = await db.delete(flashcardDecks).where(myDeck(userId, id)).returning({ id: flashcardDecks.id });
      return rows.length > 0;
    },
    async setDeckReady(userId, id, cards, title, meta) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(flashcardDecks)
          .set({ status: "ready", title, error: null, provider: meta.provider, model: meta.model, isMock: meta.isMock, updatedAt: new Date() })
          .where(and(myDeck(userId, id), eq(flashcardDecks.status, "generating")))
          .returning({ id: flashcardDecks.id });
        if (!row) return false;
        if (cards.length > 0) await tx.insert(flashcards).values(cards.map((c, i) => ({ deckId: id, userId, front: c.front, back: c.back, hint: c.hint, position: i })));
        return true;
      });
    },
    async setDeckError(userId, id, error, meta) {
      await db
        .update(flashcardDecks)
        .set({ status: "error", error, ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}), updatedAt: new Date() })
        .where(and(myDeck(userId, id), eq(flashcardDecks.status, "generating")));
    },
    async failStaleDecks(userId, olderThan, keepIds) {
      const conds = [eq(flashcardDecks.userId, userId), eq(flashcardDecks.status, "generating"), lte(flashcardDecks.updatedAt, olderThan)];
      if (keepIds.length) conds.push(notInArray(flashcardDecks.id, keepIds));
      const rows = await db
        .update(flashcardDecks)
        .set({ status: "error", error: "Creating the cards was interrupted. Please try again.", updatedAt: new Date() })
        .where(and(...conds))
        .returning({ id: flashcardDecks.id });
      return rows.length;
    },

    async listCards(userId, deckId) {
      const rows = await db.select().from(flashcards).where(and(eq(flashcards.userId, userId), eq(flashcards.deckId, deckId))).orderBy(asc(flashcards.position), asc(flashcards.createdAt));
      return rows.map(toCard);
    },
    async countCards(userId, deckId) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(flashcards).where(and(eq(flashcards.userId, userId), eq(flashcards.deckId, deckId)));
      return row?.n ?? 0;
    },
    async addCard(userId, deckId, card) {
      // The (deck, user) foreign key means a card can only ever be attached to the student's own deck.
      const [last] = await db.select({ p: sql<number>`coalesce(max(${flashcards.position}), -1)::int` }).from(flashcards).where(and(eq(flashcards.userId, userId), eq(flashcards.deckId, deckId)));
      try {
        const [row] = await db.insert(flashcards).values({ deckId, userId, front: card.front, back: card.back, hint: card.hint, position: (last?.p ?? -1) + 1 }).returning();
        return row ? toCard(row) : null;
      } catch {
        return null;
      }
    },
    async getCard(userId, cardId) {
      const [row] = await db.select().from(flashcards).where(myCard(userId, cardId)).limit(1);
      return row ? toCard(row) : null;
    },
    async updateCard(userId, cardId, patch) {
      const [row] = await db.update(flashcards).set(patch).where(myCard(userId, cardId)).returning();
      return row ? toCard(row) : null;
    },
    async deleteCard(userId, cardId) {
      const rows = await db.delete(flashcards).where(myCard(userId, cardId)).returning({ id: flashcards.id });
      return rows.length > 0;
    },
    async studyCards(userId, deckId, now, limit) {
      const base = and(eq(flashcards.userId, userId), eq(flashcards.deckId, deckId));
      const due = await db
        .select()
        .from(flashcards)
        .where(and(base, isNotNull(flashcards.lastReviewedAt), lte(flashcards.dueAt, now)))
        .orderBy(asc(flashcards.dueAt))
        .limit(limit);
      if (due.length >= limit) return due.map(toCard);
      const fresh = await db
        .select()
        .from(flashcards)
        .where(and(base, isNull(flashcards.lastReviewedAt)))
        .orderBy(asc(flashcards.position), asc(flashcards.createdAt))
        .limit(limit - due.length);
      return [...due, ...fresh].map(toCard);
    },
    async saveReview(userId, cardId, next, now) {
      const [row] = await db
        .update(flashcards)
        .set({ easeX100: next.easeX100, intervalDays: next.intervalDays, repetitions: next.repetitions, lapses: next.lapses, dueAt: next.dueAt, lastReviewedAt: now })
        .where(myCard(userId, cardId))
        .returning();
      return row ? toCard(row) : null;
    },
    async summary(userId, now, dayStart) {
      const [row] = await db
        .select({
          dueTotal: sql<number>`(count(*) filter (where ${flashcards.lastReviewedAt} is not null and ${flashcards.dueAt} <= ${now.toISOString()}::timestamptz))::int`,
          reviewedToday: sql<number>`(count(*) filter (where ${flashcards.lastReviewedAt} >= ${dayStart.toISOString()}::timestamptz))::int`,
        })
        .from(flashcards)
        .where(eq(flashcards.userId, userId));
      return { dueTotal: row?.dueTotal ?? 0, reviewedToday: row?.reviewedToday ?? 0 };
    },

    async createMap(userId, input) {
      const [row] = await db.insert(mindmaps).values({ userId, title: input.title, sourceType: input.source.type, source: input.source, size: input.size }).returning();
      return toMap(row!);
    },
    async getMap(userId, id) {
      const [row] = await db.select().from(mindmaps).where(myMap(userId, id)).limit(1);
      return row ? toMap(row) : null;
    },
    async listMaps(userId, limit) {
      const rows = await db.select().from(mindmaps).where(eq(mindmaps.userId, userId)).orderBy(desc(mindmaps.createdAt)).limit(limit);
      return rows.map(toMap);
    },
    async countMaps(userId) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(mindmaps).where(eq(mindmaps.userId, userId));
      return row?.n ?? 0;
    },
    async renameMap(userId, id, title) {
      const [row] = await db.update(mindmaps).set({ title, updatedAt: new Date() }).where(myMap(userId, id)).returning();
      return row ? toMap(row) : null;
    },
    async deleteMap(userId, id) {
      const rows = await db.delete(mindmaps).where(myMap(userId, id)).returning({ id: mindmaps.id });
      return rows.length > 0;
    },
    async setMapReady(userId, id, result, meta) {
      const rows = await db
        .update(mindmaps)
        .set({ status: "ready", error: null, tree: result.tree, nodeCount: result.nodeCount, title: result.title, provider: meta.provider, model: meta.model, isMock: meta.isMock, updatedAt: new Date() })
        .where(and(myMap(userId, id), eq(mindmaps.status, "generating")))
        .returning({ id: mindmaps.id });
      return rows.length > 0;
    },
    async setMapError(userId, id, error, meta) {
      await db
        .update(mindmaps)
        .set({ status: "error", error, ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}), updatedAt: new Date() })
        .where(and(myMap(userId, id), eq(mindmaps.status, "generating")));
    },
    async failStaleMaps(userId, olderThan, keepIds) {
      const conds = [eq(mindmaps.userId, userId), eq(mindmaps.status, "generating"), lte(mindmaps.updatedAt, olderThan)];
      if (keepIds.length) conds.push(notInArray(mindmaps.id, keepIds));
      const rows = await db
        .update(mindmaps)
        .set({ status: "error", error: "Creating the mind map was interrupted. Please try again.", updatedAt: new Date() })
        .where(and(...conds))
        .returning({ id: mindmaps.id });
      return rows.length;
    },

  };
}
