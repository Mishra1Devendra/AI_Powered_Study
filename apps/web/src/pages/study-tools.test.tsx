import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck, Flashcard, Mindmap, MindmapNode } from "@copilot/shared";
import { AuthProvider } from "../auth/AuthProvider";
import DeckPage from "./DeckPage";
import FlashcardsPage from "./FlashcardsPage";
import MindmapPage from "./MindmapPage";
import MindmapsPage from "./MindmapsPage";
import StudyPage from "./StudyPage";

const ME = "11111111-1111-4111-8111-111111111111";
const DECK = "d1111111-1111-4111-8111-111111111111";
const NOTE = "e1111111-1111-4111-8111-111111111111";
const MAP = "a1111111-1111-4111-8111-111111111111";
const NOW = "2026-10-06T09:00:00.000Z";

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

const deck = (over: Partial<Deck> = {}): Deck => ({ id: DECK, title: "Cell biology", sourceType: "notes", status: "ready", error: null, isMock: false, cardCount: 2, dueCount: 1, newCount: 1, createdAt: NOW, updatedAt: NOW, ...over });
const card = (n: number, over: Partial<Flashcard> = {}): Flashcard => ({
  id: `c${n}111111-1111-4111-8111-111111111111`,
  deckId: DECK,
  front: `Question ${n}?`,
  back: `Answer ${n}`,
  hint: null,
  state: "new",
  dueAt: NOW,
  intervalDays: 0,
  repetitions: 0,
  lapses: 0,
  nextDays: { again: 0, hard: 1, good: 1, easy: 4 },
  ...over,
});
const node = (id: string, label: string, children: MindmapNode[] = [], note?: string): MindmapNode => ({ id, label, children, ...(note ? { note } : {}) });
const tree = node("n0", "Cells", [node("n1", "Nucleus", [node("n2", "DNA"), node("n3", "Nucleolus")], "Holds the DNA."), node("n4", "Membrane")]);
const map = (over: Partial<Mindmap> = {}): Mindmap => ({ id: MAP, title: "Cells map", sourceType: "topic", size: "medium", status: "ready", error: null, isMock: false, nodeCount: 5, tree, createdAt: NOW, ...over });

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
let routes: Array<[RegExp, (call: Call) => unknown]>;

function respond(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const call: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      for (const [pattern, handler] of routes) {
        if (pattern.test(`${call.method} ${url}`)) {
          const out = handler(call);
          return out instanceof Response ? out : respond(200, out);
        }
      }
      return respond(404, { error: "not_found", message: "Not found." });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = (path: string, element: React.ReactNode, pattern: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client()}>
        <Routes>
          <Route path={pattern} element={element} />
          <Route path="/flashcards/:deckId" element={<DeckPage />} />
          <Route path="/mindmaps/:id" element={<MindmapPage />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe("study screen", () => {
  function queue(cards: Flashcard[], remaining = 0) {
    routes.push([/GET \/api\/flashcards\/decks\/.*\/study/, () => ({ deck: deck(), cards, remaining })]);
    routes.push([/POST \/api\/flashcards\/cards\/.*\/review/, (c) => ({ card: card(1, { state: "review", intervalDays: 1, repetitions: 1, nextDays: { again: 0, hard: 2, good: 3, easy: 6 }, ...(c.body ? {} : {}) }) })]);
  }

  it("shows the question first, flips on request, and offers four answers with when each brings the card back", async () => {
    queue([card(1), card(2)]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    expect(await screen.findByText("Question 1?")).toBeInTheDocument();
    expect(screen.queryByText("Answer 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show answer/i }));
    expect(screen.getByText("Answer 1")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: /how well did you remember/i });
    expect(within(group).getByRole("button", { name: /again/i })).toHaveTextContent("<10 min");
    expect(within(group).getByRole("button", { name: /good/i })).toHaveTextContent("1 day");
    expect(within(group).getByRole("button", { name: /easy/i })).toHaveTextContent("4 days");
  });

  it("sends only the grade; the next card appears; a finished round shows what happened", async () => {
    queue([card(1), card(2)]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    await userEvent.click(await screen.findByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^good/i }));
    expect(await screen.findByText("Question 2?")).toBeInTheDocument();
    const review = calls.find((c) => c.method === "POST" && /\/review$/.test(c.url))!;
    expect(review.url).toContain(card(1).id);
    expect(review.body).toEqual({ grade: "good" });

    await userEvent.click(screen.getByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^easy/i }));
    expect(await screen.findByRole("heading", { name: "Round complete" })).toBeInTheDocument();
    expect(screen.getByText(/You reviewed 2 cards/)).toBeInTheDocument();
  });

  it("a forgotten card comes back later in the same round", async () => {
    queue([card(1), card(2)]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    await userEvent.click(await screen.findByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^again/i }));
    expect(await screen.findByText("Question 2?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^good/i }));
    expect(await screen.findByText("Question 1?")).toBeInTheDocument();
  });

  it("works from the keyboard: Space flips, 3 answers 'good'", async () => {
    queue([card(1), card(2)]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    await screen.findByText("Question 1?");
    await userEvent.keyboard(" ");
    expect(await screen.findByText("Answer 1")).toBeInTheDocument();
    await userEvent.keyboard("3");
    expect(await screen.findByText("Question 2?")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && (c.body as { grade?: string })?.grade === "good")).toBe(true);
  });

  it("keeps the card and says so when saving the answer fails", async () => {
    routes.push([/GET \/api\/flashcards\/decks\/.*\/study/, () => ({ deck: deck(), cards: [card(1)], remaining: 0 })]);
    routes.push([/POST .*review/, () => respond(500, { error: "internal_error", message: "boom" })]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    await userEvent.click(await screen.findByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^good/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save that answer/i);
    expect(screen.getByText("Answer 1")).toBeInTheDocument();
  });

  it("says 'all caught up' when nothing is due, and offers more when a round was capped", async () => {
    routes.push([/GET .*study/, () => ({ deck: deck({ dueCount: 0, newCount: 0 }), cards: [], remaining: 0 })]);
    const first = mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    expect(await screen.findByRole("heading", { name: /all caught up/i })).toBeInTheDocument();
    first.unmount();

    routes.length = 0;
    routes.push([/GET .*study/, () => ({ deck: deck(), cards: [card(1)], remaining: 7 })]);
    routes.push([/POST .*review/, () => ({ card: card(1) })]);
    mount(`/flashcards/${DECK}/study`, <StudyPage />, "/flashcards/:deckId/study");
    await userEvent.click(await screen.findByRole("button", { name: /show answer/i }));
    await userEvent.click(screen.getByRole("button", { name: /^good/i }));
    expect(await screen.findByRole("button", { name: /keep going \(7 more\)/i })).toBeInTheDocument();
  });
});

describe("flashcards home", () => {
  it("lists decks with due and new counts, and links to study only decks that have something to study", async () => {
    routes.push([/GET \/api\/flashcards\/decks$/, () => ({ decks: [deck(), deck({ id: "d2222222-2222-4222-8222-222222222222", title: "Caught up", dueCount: 0, newCount: 0 })], dueTotal: 1, reviewedToday: 5 })]);
    mount("/flashcards", <FlashcardsPage />, "/flashcards");
    expect(await screen.findByText("Cell biology")).toBeInTheDocument();
    expect(screen.getByText("Due for review").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Reviewed today").nextSibling).toHaveTextContent("5");
    const items = within(screen.getByRole("list", { name: "Your decks" })).getAllByRole("listitem");
    expect(within(items[0]!).getByRole("link", { name: "Study" })).toHaveAttribute("href", `/flashcards/${DECK}/study`);
    expect(within(items[1]!).queryByRole("link", { name: "Study" })).not.toBeInTheDocument();
  });

  it("shows a friendly first-time screen when there are no decks", async () => {
    routes.push([/GET \/api\/flashcards\/decks$/, () => ({ decks: [], dueTotal: 0, reviewedToday: 0 })]);
    mount("/flashcards", <FlashcardsPage />, "/flashcards");
    expect(await screen.findByRole("heading", { name: /turn your notes into flashcards/i })).toBeInTheDocument();
  });

  it("writes a deck from a chosen note and opens it while it is being written", async () => {
    routes.push([/GET \/api\/flashcards\/decks$/, () => ({ decks: [], dueTotal: 0, reviewedToday: 0 })]);
    routes.push([/GET \/api\/quiz\/options/, () => ({ notes: [{ id: NOTE, title: "Chapter 3", chunkCount: 4, pageCount: 12 }], topics: [] })]);
    routes.push([/POST \/api\/flashcards\/decks\/generate/, () => respond(202, { deck: deck({ status: "generating", cardCount: 0, dueCount: 0, newCount: 0 }) })]);
    routes.push([/GET \/api\/flashcards\/decks\/d1111111/, () => ({ deck: deck({ status: "generating", cardCount: 0, dueCount: 0, newCount: 0 }), cards: [] })]);
    mount(`/flashcards?document=${NOTE}`, <FlashcardsPage />, "/flashcards");
    // arrives from a note: the panel is open and that note is already chosen, but nothing started by itself
    const box = await screen.findByRole("checkbox", { name: /chapter 3/i });
    expect(box).toBeChecked();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "20" }));
    await userEvent.click(screen.getByRole("button", { name: /write my cards/i }));
    expect(await screen.findByText(/writing your cards/i)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ source: { type: "notes", documentIds: [NOTE] }, count: 20 });
  });

  it("asks for a subject, and sends it, when writing from a topic", async () => {
    routes.push([/GET \/api\/flashcards\/decks$/, () => ({ decks: [], dueTotal: 0, reviewedToday: 0 })]);
    routes.push([/GET \/api\/quiz\/options/, () => ({ notes: [], topics: [{ subject: "Physics", topic: null }] })]);
    routes.push([/POST \/api\/flashcards\/decks\/generate/, () => respond(429, { error: "too_many_generations", message: "You've created 20 AI flashcard sets and mind maps today." })]);
    mount("/flashcards", <FlashcardsPage />, "/flashcards");
    await userEvent.click(await screen.findByRole("button", { name: /make my first deck/i }));
    await userEvent.click(await screen.findByRole("button", { name: /write my cards/i }));
    expect(await screen.findByText("Enter a subject.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Subject"), "Biology");
    await userEvent.click(screen.getByRole("button", { name: /write my cards/i }));
    expect(await screen.findByText(/created 20 AI flashcard sets/i)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ source: { type: "topic", subject: "Biology" }, count: 12 });
  });
});

describe("deck page", () => {
  it("shows the cards with their state, adds a card and deletes one", async () => {
    let cards = [card(1), card(2, { state: "review", intervalDays: 3, dueAt: "2099-01-01T00:00:00.000Z" })];
    routes.push([/GET \/api\/flashcards\/decks\/d1111111/, () => ({ deck: deck({ cardCount: cards.length }), cards })]);
    routes.push([/POST .*\/cards$/, (c) => ((cards = [...cards, card(3, { front: (c.body as { front: string }).front, back: (c.body as { back: string }).back })]), respond(201, { card: cards.at(-1) }))]);
    routes.push([/DELETE .*\/cards\//, () => ((cards = cards.slice(1)), respond(204, null))]);
    mount(`/flashcards/${DECK}`, <DeckPage />, "/flashcards/:deckId");
    expect(await screen.findByText("Question 1?")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText(/Due in \d+ days?/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add a card/i }));
    await userEvent.type(screen.getByLabelText(/front/i), "What is DNA?");
    await userEvent.type(screen.getByLabelText(/back/i), "A genetic molecule");
    await userEvent.click(screen.getByRole("button", { name: "Add card" }));
    expect(await screen.findByText("What is DNA?")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ front: "What is DNA?", back: "A genetic molecule" });

    await userEvent.click(screen.getByRole("button", { name: /delete card: question 1\?/i }));
    await waitFor(() => expect(screen.queryByText("Question 1?")).not.toBeInTheDocument());
  });

  it("asks before deleting a deck, and says so plainly when the deck is gone", async () => {
    routes.push([/GET \/api\/flashcards\/decks\/d1111111/, () => ({ deck: deck(), cards: [card(1), card(2)] })]);
    routes.push([/DELETE \/api\/flashcards\/decks\//, () => respond(204, null)]);
    mount(`/flashcards/${DECK}`, <DeckPage />, "/flashcards/:deckId");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/delete this deck and its 2 cards/i);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete deck" }));
    expect(await screen.findByText("elsewhere")).toBeInTheDocument();
  });

  it("shows a deck that failed with its reason, and one that is still being written", async () => {
    routes.push([/GET \/api\/flashcards\/decks\/d1111111/, () => ({ deck: deck({ status: "error", error: "The AI's answer couldn't be read. Please try again.", cardCount: 0 }), cards: [] })]);
    const view = mount(`/flashcards/${DECK}`, <DeckPage />, "/flashcards/:deckId");
    expect(await screen.findByRole("alert")).toHaveTextContent("The AI's answer couldn't be read");
    view.unmount();
    routes.length = 0;
    routes.push([/GET \/api\/flashcards\/decks\/d1111111/, () => ({ deck: deck({ status: "generating", cardCount: 0 }), cards: [] })]);
    mount(`/flashcards/${DECK}`, <DeckPage />, "/flashcards/:deckId");
    expect(await screen.findByText(/writing your cards. this usually takes/i)).toBeInTheDocument();
  });
});

describe("mind maps", () => {
  it("opens a map, folds and unfolds a branch, shows a note, and has a plain outline view", async () => {
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map() })]);
    mount(`/mindmaps/${MAP}`, <MindmapPage />, "/mindmaps/:id");
    const nucleus = await screen.findByRole("button", { name: /^Nucleus, press to fold/ });
    expect(screen.getByRole("button", { name: "DNA" })).toBeInTheDocument();
    await userEvent.click(nucleus);
    expect(screen.queryByRole("button", { name: "DNA" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Nucleus, folded/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Holds the DNA.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Nucleus, folded/ }));
    expect(screen.getByRole("button", { name: "DNA" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByRole("button", { name: "Nucleolus" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "Nucleolus" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Outline" }));
    const outline = screen.getByRole("list", { name: "Mind map outline" });
    expect(within(outline).getByText("Nucleolus")).toBeInTheDocument();
    expect(within(outline).getByText("Holds the DNA.")).toBeInTheDocument();
  });

  it("zooms with the buttons and stops at the limits", async () => {
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map() })]);
    mount(`/mindmaps/${MAP}`, <MindmapPage />, "/mindmaps/:id");
    await screen.findByRole("button", { name: /Nucleus/ });
    expect(screen.getByText("100%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeInTheDocument();
    for (let i = 0; i < 6; i++) if (!screen.getByRole("button", { name: "Zoom out" }).hasAttribute("disabled")) await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    for (let i = 0; i < 8; i++) if (!screen.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")) await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("200%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  });

  it("shows progress while a map is being drawn, and the reason when it failed", async () => {
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map({ status: "generating", tree: null, nodeCount: 0 }) })]);
    const view = mount(`/mindmaps/${MAP}`, <MindmapPage />, "/mindmaps/:id");
    expect(await screen.findByText(/drawing your map. this usually takes/i)).toBeInTheDocument();
    view.unmount();
    routes.length = 0;
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map({ status: "error", tree: null, error: "This took too long. Please try again." }) })]);
    mount(`/mindmaps/${MAP}`, <MindmapPage />, "/mindmaps/:id");
    expect(await screen.findByRole("alert")).toHaveTextContent("This took too long");
  });

  it("draws again from the same source and opens the new map", async () => {
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map() })]);
    routes.push([/POST .*regenerate/, () => respond(202, { mindmap: map({ id: "a2222222-2222-4222-8222-222222222222", status: "generating", tree: null, nodeCount: 0 }) })]);
    routes.push([/GET \/api\/mindmaps\/a2222222/, () => ({ mindmap: map({ id: "a2222222-2222-4222-8222-222222222222", status: "generating", tree: null, nodeCount: 0 }) })]);
    mount(`/mindmaps/${MAP}`, <MindmapPage />, "/mindmaps/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Draw again" }));
    expect(await screen.findByText(/drawing your map/i)).toBeInTheDocument();
  });

  it("lists maps and starts one from a subject", async () => {
    routes.push([/GET \/api\/mindmaps$/, () => ({ mindmaps: [map({ tree: null }), map({ id: "a3333333-3333-4333-8333-333333333333", title: "Being drawn", status: "generating", tree: null, nodeCount: 0 })] })]);
    routes.push([/GET \/api\/quiz\/options/, () => ({ notes: [], topics: [] })]);
    routes.push([/POST \/api\/mindmaps\/generate/, () => respond(202, { mindmap: map({ status: "generating", tree: null, nodeCount: 0 }) })]);
    routes.push([/GET \/api\/mindmaps\/a1111111/, () => ({ mindmap: map({ status: "generating", tree: null, nodeCount: 0 }) })]);
    mount("/mindmaps", <MindmapsPage />, "/mindmaps");
    const list = await screen.findByRole("list", { name: "Your mind maps" });
    expect(within(list).getByText("Cells map")).toBeInTheDocument();
    expect(within(list).getByText(/drawing your map/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new mind map/i }));
    await userEvent.type(await screen.findByLabelText("Subject"), "Cells");
    await userEvent.click(screen.getByRole("button", { name: /large/i }));
    await userEvent.click(screen.getByRole("button", { name: /draw my map/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ source: { type: "topic", subject: "Cells" }, size: "large" });
  });
});
