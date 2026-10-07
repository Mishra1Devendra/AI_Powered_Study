import { describe, expect, it } from "vitest";
import { STUDY_TOOLS_LIMITS } from "@copilot/shared";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";
import { createInMemoryStudyToolsRepository } from "./memory.js";
import { createStudyToolsService } from "./service.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const clock = { t: new Date("2026-10-06T09:00:00Z") };
const now = () => new Date(clock.t);

function answering(text: string, calls: { n: number } = { n: 0 }): LLMProvider {
  return {
    name: "ollama",
    model: "test-model",
    isMock: false,
    generateText: async (): Promise<GenerateTextResult> => ((calls.n += 1), { text, provider: "ollama", model: "test-model", isMock: false }),
    streamText: async function* () {
      yield text;
      return {};
    },
  };
}

function make(ai: LLMProvider = new MockProvider(0), opts: { jobDeadlineMs?: number } = {}) {
  const notes = createInMemoryNotesRepository(createInMemoryTutorRepository());
  const store = createInMemoryStudyToolsRepository(now);
  const service = createStudyToolsService({ repo: store.repo, notes: notes.repo, ai, now, ...opts });
  return { service, store, notes };
}

async function readyNote(notes: ReturnType<typeof make>["notes"], userId = A, id = NOTE) {
  await notes.repo.createDocument({ id, userId, title: "Cell biology", originalFilename: "cells.txt", fileType: "txt", source: "paste", mimeType: "text/plain", fileSize: 900, contentHash: id, storagePath: `${userId}/${id}` });
  const text = "The mitochondrion produces ATP, the main energy currency of the cell. The nucleus stores DNA and controls what the cell does. Ribosomes build proteins from amino acids using instructions copied from DNA.";
  await notes.repo.saveChunksAndMarkReady(userId, id, [{ index: 0, page: null, pageEnd: null, heading: "Organelles", headingPath: ["Organelles"], content: text }], { pageCount: null } as never);
}

const topic = { type: "topic" as const, subject: "Biology", topic: "Cells" };

describe("flashcards: writing a deck", () => {
  it("starts at once as 'generating', then becomes ready with the cards (demo AI is labelled)", async () => {
    const { service } = make();
    const deck = await service.generateDeck(A, { source: topic, count: 6 });
    expect(deck).toMatchObject({ status: "generating", cardCount: 0, title: "Biology" });
    await service.idle();
    const { deck: ready, cards } = await service.getDeck(A, deck.id);
    expect(ready).toMatchObject({ status: "ready", isMock: true, cardCount: 6, newCount: 6, dueCount: 0 });
    expect(cards).toHaveLength(6);
    expect(cards[0]).toMatchObject({ state: "new", repetitions: 0, nextDays: { again: 0, hard: 1, good: 1, easy: 4 } });
  });

  it("makes ONE AI call per deck, and uses the real model's cards", async () => {
    const calls = { n: 0 };
    const { service } = make(answering(JSON.stringify({ cards: [{ front: "What is ATP?", back: "Energy." }, { front: "What is DNA?", back: "Genes." }, { front: "What is RNA?", back: "Copy." }, { front: "What is a cell?", back: "Unit." }] }), calls));
    const deck = await service.generateDeck(A, { source: topic, count: 6, title: "My deck" });
    await service.idle();
    expect(calls.n).toBe(1);
    const got = await service.getDeck(A, deck.id);
    expect(got.deck).toMatchObject({ status: "ready", title: "My deck", isMock: false, cardCount: 4 });
  });

  it("works from the student's own notes, and refuses someone else's or a missing note", async () => {
    const { service, notes } = make();
    await readyNote(notes, A);
    const deck = await service.generateDeck(A, { source: { type: "notes", documentIds: [NOTE], focus: "ATP" }, count: 5 });
    await service.idle();
    expect((await service.getDeck(A, deck.id)).deck).toMatchObject({ status: "ready", title: "Cell biology", sourceType: "notes" });
    await expect(service.generateDeck(B, { source: { type: "notes", documentIds: [NOTE] }, count: 5 })).rejects.toMatchObject({ status: 404 });
  });

  it("shows a student-safe error when the AI's answer is unusable, and does not store a half deck", async () => {
    const { service } = make(answering("I cannot do that."));
    const deck = await service.generateDeck(A, { source: topic, count: 6 });
    await service.idle();
    const got = await service.getDeck(A, deck.id);
    expect(got.deck).toMatchObject({ status: "error", error: "The AI's answer couldn't be read. Please try again.", cardCount: 0 });
  });

  it("a model that never answers is cut off at the job deadline", async () => {
    const stuck: LLMProvider = {
      ...answering("x"),
      generateText: (req: GenerateTextRequest) => new Promise<GenerateTextResult>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const { service } = make(stuck, { jobDeadlineMs: 30 });
    const deck = await service.generateDeck(A, { source: topic, count: 5 });
    await service.idle();
    expect((await service.getDeck(A, deck.id)).deck).toMatchObject({ status: "error", error: "This took too long. Please try again." });
  });

  it("allows at most two writing jobs per student at a time (the daily AI allowance is charged by the routes)", async () => {
    const stuck: LLMProvider = { ...answering("x"), generateText: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))) };
    const busy = make(stuck, { jobDeadlineMs: 50 });
    await busy.service.generateDeck(A, { source: topic, count: 5 });
    await busy.service.generateMindmap(A, { source: topic, size: "small" });
    await expect(busy.service.generateDeck(A, { source: topic, count: 5 })).rejects.toMatchObject({ status: 409 });
    // Another student is not affected, and a manual deck (no AI) is never blocked.
    await expect(busy.service.generateDeck(B, { source: topic, count: 5 })).resolves.toBeTruthy();
    await expect(busy.service.createDeck(A, "By hand")).resolves.toMatchObject({ sourceType: "manual", status: "ready" });
    await busy.service.idle();
    // Once the jobs have finished, the student can start again.
    await expect(busy.service.generateDeck(A, { source: topic, count: 5 })).resolves.toBeTruthy();
    await busy.service.idle();
  });

  it("marks a deck whose job was lost (restart) as failed, instead of 'generating' forever", async () => {
    const { service, store } = make();
    const orphan = await store.repo.createDeck(A, { title: "Lost", sourceType: "topic", status: "generating" });
    clock.t = new Date("2026-10-06T09:30:00Z");
    expect((await service.getDeck(A, orphan.id)).deck.status).toBe("error");
    clock.t = new Date("2026-10-06T09:00:00Z");
  });
});

describe("flashcards: cards and studying", () => {
  async function deckWithCards() {
    const ctx = make();
    const deck = await ctx.service.createDeck(A, "Chem");
    const a = await ctx.service.addCard(A, deck.id, { front: "H2O?", back: "Water", hint: "  liquid " });
    const b = await ctx.service.addCard(A, deck.id, { front: "NaCl?", back: "Salt" });
    return { ...ctx, deck, a, b };
  }

  it("adds, edits and deletes cards; a blank hint clears it", async () => {
    const { service, deck, a } = await deckWithCards();
    expect(a.hint).toBe("liquid");
    expect(await service.updateCard(A, a.id, { back: "Water (H₂O)", hint: " " })).toMatchObject({ back: "Water (H₂O)", hint: null });
    await service.deleteCard(A, a.id);
    expect((await service.getDeck(A, deck.id)).cards).toHaveLength(1);
    await expect(service.deleteCard(A, a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("another student can read, change, review and delete nothing of this deck (404, like a missing one)", async () => {
    const { service, deck, a } = await deckWithCards();
    await expect(service.getDeck(B, deck.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.renameDeck(B, deck.id, "x")).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteDeck(B, deck.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.addCard(B, deck.id, { front: "f", back: "b" })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateCard(B, a.id, { front: "hacked" })).rejects.toMatchObject({ status: 404 });
    await expect(service.review(B, a.id, "easy")).rejects.toMatchObject({ status: 404 });
    await expect(service.studyQueue(B, deck.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.listDecks(B)).decks).toEqual([]);
    expect((await service.getDeck(A, deck.id)).cards[0]!.front).toBe("H2O?");
  });

  it("a review is scheduled by the server: 'good' hides the card until tomorrow, 'again' brings it back in minutes", async () => {
    const { service, deck, a, b } = await deckWithCards();
    const good = await service.review(A, a.id, "good");
    expect(good).toMatchObject({ state: "review", intervalDays: 1, repetitions: 1 });
    expect(good.dueAt).toBe("2026-10-07T09:00:00.000Z");
    const again = await service.review(A, b.id, "again");
    expect(again).toMatchObject({ state: "learning", lapses: 1, intervalDays: 0 });
    expect(again.dueAt).toBe("2026-10-06T09:10:00.000Z");

    // Right now nothing is due; ten minutes later the forgotten card is; tomorrow both are.
    expect((await service.studyQueue(A, deck.id)).cards).toEqual([]);
    clock.t = new Date("2026-10-06T09:11:00Z");
    expect((await service.studyQueue(A, deck.id)).cards.map((c) => c.id)).toEqual([b.id]);
    clock.t = new Date("2026-10-07T09:01:00Z");
    expect((await service.studyQueue(A, deck.id)).cards.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    clock.t = new Date("2026-10-06T09:00:00Z");
  });

  it("the study round lists due cards first, then new ones, and reports what is left", async () => {
    const { service, store } = make();
    const deck = await service.createDeck(A, "Big");
    for (let i = 0; i < STUDY_TOOLS_LIMITS.studyBatch + 5; i++) await service.addCard(A, deck.id, { front: `Q${i}?`, back: `A${i}` });
    const round = await service.studyQueue(A, deck.id);
    expect(round.cards).toHaveLength(STUDY_TOOLS_LIMITS.studyBatch);
    expect(round.remaining).toBe(5);
    expect(round.cards[0]!.front).toBe("Q0?");
    // Review one, push it into the past so it is due: it must come first.
    const last = (await service.getDeck(A, deck.id)).cards.at(-1)!;
    await service.review(A, last.id, "again");
    clock.t = new Date("2026-10-06T10:00:00Z");
    expect((await service.studyQueue(A, deck.id)).cards[0]!.id).toBe(last.id);
    clock.t = new Date("2026-10-06T09:00:00Z");
    void store;
  });

  it("summarises what is due and what was reviewed today across decks", async () => {
    const { service, deck, a } = await deckWithCards();
    await service.review(A, a.id, "again");
    clock.t = new Date("2026-10-06T09:20:00Z");
    const list = await service.listDecks(A);
    expect(list).toMatchObject({ dueTotal: 1, reviewedToday: 1 });
    expect(list.decks.find((d) => d.id === deck.id)).toMatchObject({ cardCount: 2, dueCount: 1, newCount: 1 });
    clock.t = new Date("2026-10-06T09:00:00Z");
  });

  it("refuses to add cards past the deck limit and cards to a deck that is still being written", async () => {
    const { service, store } = make();
    const writing = await store.repo.createDeck(A, { title: "W", sourceType: "topic", status: "generating" });
    await expect(service.addCard(A, writing.id, { front: "f", back: "b" })).rejects.toMatchObject({ status: 409 });
    await expect(service.studyQueue(A, writing.id)).rejects.toMatchObject({ status: 409 });
    const deck = await service.createDeck(A, "Full");
    for (let i = 0; i < STUDY_TOOLS_LIMITS.maxCardsPerDeck; i++) await store.repo.addCard(A, deck.id, { front: `q${i}`, back: "a", hint: null });
    await expect(service.addCard(A, deck.id, { front: "one more", back: "a" })).rejects.toMatchObject({ status: 409, code: "too_many_cards" });
  });

  it("deleting a deck deletes its cards", async () => {
    const { service, store, deck } = await deckWithCards();
    await service.deleteDeck(A, deck.id);
    expect(store.cards).toHaveLength(0);
  });
});

describe("mind maps", () => {
  it("starts as 'generating', then is ready with the tree (list responses carry no tree)", async () => {
    const { service } = make();
    const m = await service.generateMindmap(A, { source: topic, size: "medium" });
    expect(m).toMatchObject({ status: "generating", tree: null });
    await service.idle();
    const got = await service.getMindmap(A, m.id);
    expect(got).toMatchObject({ status: "ready", isMock: true, size: "medium" });
    expect(got.tree!.children.length).toBeGreaterThanOrEqual(2);
    expect(got.nodeCount).toBeGreaterThan(5);
    const [listed] = await service.listMindmaps(A);
    expect(listed).toMatchObject({ id: m.id, tree: null, nodeCount: got.nodeCount });
  });

  it("reports an unusable AI answer without storing a tree", async () => {
    const { service } = make(answering('{"title":"x"}'));
    const m = await service.generateMindmap(A, { source: topic, size: "small" });
    await service.idle();
    expect(await service.getMindmap(A, m.id)).toMatchObject({ status: "error", tree: null, error: "The AI's answer couldn't be read. Please try again." });
  });

  it("can be renamed, regenerated from the same source (the old map is kept) and deleted - only by its owner", async () => {
    const { service, notes } = make();
    await readyNote(notes, A);
    const m = await service.generateMindmap(A, { source: { type: "notes", documentIds: [NOTE] }, size: "small", title: "Cells map" });
    await service.idle();
    expect((await service.renameMindmap(A, m.id, "Renamed")).title).toBe("Renamed");
    const again = await service.regenerateMindmap(A, m.id);
    await service.idle();
    expect(again.id).not.toBe(m.id);
    expect((await service.listMindmaps(A)).map((x) => x.title)).toEqual(["Renamed", "Renamed"]);
    await expect(service.getMindmap(B, m.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.renameMindmap(B, m.id, "x")).rejects.toMatchObject({ status: 404 });
    await expect(service.regenerateMindmap(B, m.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteMindmap(B, m.id)).rejects.toMatchObject({ status: 404 });
    await service.deleteMindmap(A, m.id);
    expect(await service.listMindmaps(A)).toHaveLength(1);
  });
});
