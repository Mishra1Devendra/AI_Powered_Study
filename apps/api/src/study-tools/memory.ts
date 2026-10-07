import type { CardRecord, DeckCounts, DeckRecord, MapRecord, StudyToolsRepository } from "./repository.js";

/** In-memory StudyToolsRepository for tests. Mirrors the SQL rules: per-user scoping, status transitions, due/new ordering. */
export function createInMemoryStudyToolsRepository(clock: () => Date = () => new Date()) {
  const decks: DeckRecord[] = [];
  const cards: CardRecord[] = [];
  const maps: MapRecord[] = [];
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const deck = (u: string, i: string) => decks.find((d) => d.userId === u && d.id === i);
  const card = (u: string, i: string) => cards.find((c) => c.userId === u && c.id === i);
  const map = (u: string, i: string) => maps.find((m) => m.userId === u && m.id === i);
  const isDue = (c: CardRecord, now: Date) => c.lastReviewedAt !== null && c.dueAt <= now;

  const repo: StudyToolsRepository = {
    async createDeck(userId, input) {
      const t = clock();
      const d: DeckRecord = { id: id(), userId, title: input.title, sourceType: input.sourceType, status: input.status, error: null, isMock: false, createdAt: t, updatedAt: t };
      decks.push(d);
      return { ...d };
    },
    async getDeck(u, i) {
      const d = deck(u, i);
      return d ? { ...d } : null;
    },
    async listDecks(u, limit) {
      return decks
        .filter((d) => d.userId === u)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((d) => ({ ...d }));
    },
    async countDecks(u) {
      return decks.filter((d) => d.userId === u).length;
    },
    async deckCounts(u, ids, now) {
      const out = new Map<string, DeckCounts>();
      for (const deckId of ids) {
        const mine = cards.filter((c) => c.userId === u && c.deckId === deckId);
        if (mine.length) out.set(deckId, { cardCount: mine.length, dueCount: mine.filter((c) => isDue(c, now)).length, newCount: mine.filter((c) => c.lastReviewedAt === null).length });
      }
      return out;
    },
    async renameDeck(u, i, title) {
      const d = deck(u, i);
      if (!d) return null;
      Object.assign(d, { title, updatedAt: clock() });
      return { ...d };
    },
    async deleteDeck(u, i) {
      const at = decks.findIndex((d) => d.userId === u && d.id === i);
      if (at < 0) return false;
      decks.splice(at, 1);
      for (let k = cards.length - 1; k >= 0; k--) if (cards[k]!.deckId === i) cards.splice(k, 1);
      return true;
    },
    async setDeckReady(u, i, list, title, meta) {
      const d = deck(u, i);
      if (!d || d.status !== "generating") return false;
      Object.assign(d, { status: "ready", title, error: null, isMock: meta.isMock, updatedAt: clock() });
      list.forEach((c, position) => cards.push({ id: id(), deckId: i, userId: u, front: c.front, back: c.back, hint: c.hint, position, easeX100: 250, intervalDays: 0, repetitions: 0, lapses: 0, dueAt: clock(), lastReviewedAt: null, createdAt: clock() }));
      return true;
    },
    async setDeckError(u, i, error, meta) {
      const d = deck(u, i);
      if (!d || d.status !== "generating") return;
      Object.assign(d, { status: "error", error, ...(meta ? { isMock: meta.isMock } : {}), updatedAt: clock() });
    },
    async failStaleDecks(u, olderThan, keepIds) {
      let k = 0;
      for (const d of decks) {
        if (d.userId === u && d.status === "generating" && d.updatedAt <= olderThan && !keepIds.includes(d.id)) {
          Object.assign(d, { status: "error", error: "Creating the cards was interrupted. Please try again.", updatedAt: clock() });
          k++;
        }
      }
      return k;
    },

    async listCards(u, deckId) {
      return cards.filter((c) => c.userId === u && c.deckId === deckId).sort((a, b) => a.position - b.position).map((c) => ({ ...c }));
    },
    async countCards(u, deckId) {
      return cards.filter((c) => c.userId === u && c.deckId === deckId).length;
    },
    async addCard(u, deckId, input) {
      if (!deck(u, deckId)) return null;
      const position = Math.max(-1, ...cards.filter((c) => c.deckId === deckId).map((c) => c.position)) + 1;
      const c: CardRecord = { id: id(), deckId, userId: u, front: input.front, back: input.back, hint: input.hint, position, easeX100: 250, intervalDays: 0, repetitions: 0, lapses: 0, dueAt: clock(), lastReviewedAt: null, createdAt: clock() };
      cards.push(c);
      return { ...c };
    },
    async getCard(u, i) {
      const c = card(u, i);
      return c ? { ...c } : null;
    },
    async updateCard(u, i, patch) {
      const c = card(u, i);
      if (!c) return null;
      Object.assign(c, patch);
      return { ...c };
    },
    async deleteCard(u, i) {
      const at = cards.findIndex((c) => c.userId === u && c.id === i);
      if (at < 0) return false;
      cards.splice(at, 1);
      return true;
    },
    async studyCards(u, deckId, now, limit) {
      const mine = cards.filter((c) => c.userId === u && c.deckId === deckId);
      const due = mine.filter((c) => isDue(c, now)).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
      const fresh = mine.filter((c) => c.lastReviewedAt === null).sort((a, b) => a.position - b.position);
      return [...due, ...fresh].slice(0, limit).map((c) => ({ ...c }));
    },
    async saveReview(u, i, next, now) {
      const c = card(u, i);
      if (!c) return null;
      Object.assign(c, { easeX100: next.easeX100, intervalDays: next.intervalDays, repetitions: next.repetitions, lapses: next.lapses, dueAt: next.dueAt, lastReviewedAt: now });
      return { ...c };
    },
    async summary(u, now, dayStart) {
      const mine = cards.filter((c) => c.userId === u);
      return { dueTotal: mine.filter((c) => isDue(c, now)).length, reviewedToday: mine.filter((c) => c.lastReviewedAt && c.lastReviewedAt >= dayStart).length };
    },

    async createMap(u, input) {
      const t = clock();
      const m: MapRecord = { id: id(), userId: u, title: input.title, sourceType: input.source.type, source: input.source, size: input.size, status: "generating", error: null, tree: null, nodeCount: 0, isMock: false, createdAt: t, updatedAt: t };
      maps.push(m);
      return { ...m };
    },
    async getMap(u, i) {
      const m = map(u, i);
      return m ? { ...m } : null;
    },
    async listMaps(u, limit) {
      return maps
        .filter((m) => m.userId === u)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((m) => ({ ...m }));
    },
    async countMaps(u) {
      return maps.filter((m) => m.userId === u).length;
    },
    async renameMap(u, i, title) {
      const m = map(u, i);
      if (!m) return null;
      Object.assign(m, { title, updatedAt: clock() });
      return { ...m };
    },
    async deleteMap(u, i) {
      const at = maps.findIndex((m) => m.userId === u && m.id === i);
      if (at < 0) return false;
      maps.splice(at, 1);
      return true;
    },
    async setMapReady(u, i, result, meta) {
      const m = map(u, i);
      if (!m || m.status !== "generating") return false;
      Object.assign(m, { status: "ready", error: null, tree: result.tree, nodeCount: result.nodeCount, title: result.title, isMock: meta.isMock, updatedAt: clock() });
      return true;
    },
    async setMapError(u, i, error, meta) {
      const m = map(u, i);
      if (!m || m.status !== "generating") return;
      Object.assign(m, { status: "error", error, ...(meta ? { isMock: meta.isMock } : {}), updatedAt: clock() });
    },
    async failStaleMaps(u, olderThan, keepIds) {
      let k = 0;
      for (const m of maps) {
        if (m.userId === u && m.status === "generating" && m.updatedAt <= olderThan && !keepIds.includes(m.id)) {
          Object.assign(m, { status: "error", error: "Creating the mind map was interrupted. Please try again.", updatedAt: clock() });
          k++;
        }
      }
      return k;
    },

  };
  return { repo, decks, cards, maps };
}
