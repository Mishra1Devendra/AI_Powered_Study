import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { emptyRecommendations, makeRecommendationsBackend, planOnly, richRecommendations } from "../../dev/fakeRecommendationsBackend";
import { makeBackend as makeQuizBackend } from "../../dev/fakeQuizBackend";
import { makeVivaBackend } from "../../dev/fakeVivaBackend";
import { RecommendedForYou } from "./RecommendedForYou";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function makeClient(signedIn = true) {
  const session = signedIn ? ({ access_token: "tok", user: { id: USER_ID, email: "r@example.com" } } as unknown as Session) : null;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let where = { pathname: "", search: "" };
let visits: Array<{ pathname: string; state: unknown }> = [];
function Probe() {
  const l = useLocation();
  where = { pathname: l.pathname, search: l.search };
  visits.push({ pathname: l.pathname, state: l.state });
  return null;
}

function renderAt(path = "/recommendations", signedIn = true) {
  visits = [];
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient(signedIn)}>
        <Probe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

let backend: ReturnType<typeof makeRecommendationsBackend>;
function useBackend(data = richRecommendations()) {
  backend = makeRecommendationsBackend(data);
  vi.stubGlobal("fetch", backend.fetchMock);
}
beforeEach(() => useBackend());
afterEach(() => vi.unstubAllGlobals());

const section = async (title: string) => within((await screen.findByRole("heading", { name: title })).closest("section")!);
const card = (name: string) => within(screen.getByRole("article", { name }));

describe("access and loading", () => {
  it("a signed-out visitor is sent to login and nothing is requested", async () => {
    renderAt("/recommendations", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });

  it("is a real page, reachable from the navigation (no 'Soon')", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { level: 1, name: "Your Smart Study Recommendations" })).toBeInTheDocument();
    expect(screen.getByText("Personalized recommendations based on your learning activity, practice and performance.")).toBeInTheDocument();
    expect(within(screen.getAllByRole("link", { name: /Recommendations/ })[0]!).queryByText("Soon")).toBeNull();
  });

  it("shows skeleton cards while loading", async () => {
    backend.knobs.delayMs = 150;
    renderAt();
    expect(await screen.findByRole("status", { name: "Loading your recommendations" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Recommended Now" })).toBeInTheDocument();
  });

  it("shows a clear error with Try Again, and recovers", async () => {
    backend.knobs.failNext = true;
    const { user } = renderAt();
    expect(await screen.findByText("We couldn't load your recommendations.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("heading", { name: "Recommended Now" })).toBeInTheDocument();
  });

  it("loads with ONE plain GET and makes no AI request by itself", async () => {
    renderAt();
    await screen.findByRole("heading", { name: "Recommended Now" });
    expect(backend.calls).toEqual([{ method: "GET", url: "/api/recommendations" }]);
  });
});

describe("sections", () => {
  it("'Recommended Now' holds the three most important; other sections list the rest, and empty sections are not shown", async () => {
    renderAt();
    const now = await section("Recommended Now");
    expect(now.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["Revise Photosynthesis now", "Fix repeated mistakes in Integration by parts", "Continue: Chemical bonding"]);
    expect((await section("Needs practice")).getByRole("article", { name: "Practice Thermodynamics" })).toBeInTheDocument();
    expect((await section("Improving")).getByRole("article", { name: "You're improving at Integration" })).toBeInTheDocument();
    expect((await section("Strong topics")).getByRole("article", { name: "Keep Waves fresh" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Weak topics" })).toBeNull(); // nothing left to show there
    expect(screen.queryByRole("heading", { name: "Repeated mistakes" })).toBeNull();
    // No card appears twice.
    const names = screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("a card says what, why (from the student's own facts), the suggested action and its priority - in words", async () => {
    renderAt();
    await screen.findByRole("heading", { name: "Recommended Now" });
    const c = card("Revise Photosynthesis now");
    expect(c.getByText("Urgent revision")).toBeInTheDocument();
    expect(c.getByText("High priority")).toBeInTheDocument();
    expect(c.getByText("You scored 42% across 12 questions in 3 quiz attempts. You got the same 2 questions wrong in more than one attempt. You last practiced it 9 days ago.")).toBeInTheDocument();
    expect(c.getByText("Practice 5 questions")).toBeInTheDocument();
    expect(c.getByRole("heading", { name: "Why" })).toBeInTheDocument();
    expect(c.getByRole("heading", { name: "Recommended action" })).toBeInTheDocument();
  });
});

describe("actions open the existing screens and start nothing", () => {
  it("quiz, viva, notes and study-plan buttons are links with the details filled in", async () => {
    renderAt();
    await screen.findByRole("heading", { name: "Recommended Now" });
    const c = card("Revise Photosynthesis now");
    expect(c.getByRole("link", { name: "Start Practice: Photosynthesis" })).toHaveAttribute("href", "/quiz/new?subject=Biology&topic=Photosynthesis&count=5");
    expect(c.getByRole("link", { name: "Practice Viva: Photosynthesis" })).toHaveAttribute("href", "/viva?subject=Biology&topic=Photosynthesis");
    expect(c.getByRole("link", { name: "Review notes: Photosynthesis" })).toHaveAttribute("href", "/notes/00000000-0000-4000-8000-0000000000d1");
    expect(card("Continue: Chemical bonding").getByRole("link", { name: "Open session: Chemical bonding" })).toHaveAttribute("href", "/study-plan?session=00000000-0000-4000-8000-0000000000a1");
    // The main action comes first.
    expect(within(screen.getByRole("article", { name: "Fix repeated mistakes in Integration by parts" })).getAllByRole("button", { name: /Ask Tutor/ })).toHaveLength(1);
  });

  it("Ask Tutor opens the Tutor with the question in the hand-off and sends nothing", async () => {
    const { user } = renderAt();
    await screen.findByRole("heading", { name: "Recommended Now" });
    const before = backend.calls.length;
    await user.click(card("Fix repeated mistakes in Integration by parts").getByRole("button", { name: /Ask Tutor/ }));
    await waitFor(() => expect(where.pathname).toBe("/tutor"));
    const handoff = visits.find((v) => v.pathname === "/tutor" && v.state)!.state as { draft: string; subject: string; topic: string };
    expect(handoff).toEqual({ draft: "Explain the common mistakes I make in Integration by parts", subject: "Mathematics", topic: "Integration by parts" });
    expect(backend.calls.slice(before).filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("the quiz form opens pre-filled and nothing is created", async () => {
    const quiz = makeQuizBackend();
    vi.stubGlobal("fetch", quiz.fetchMock);
    renderAt("/quiz/new?subject=Biology&topic=Photosynthesis&count=10");
    expect(await screen.findByDisplayValue("Biology")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Photosynthesis")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^10/ })).toBeChecked();
    expect(quiz.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("the viva setup opens pre-filled and nothing is started", async () => {
    const viva = makeVivaBackend();
    vi.stubGlobal("fetch", viva.fetchMock);
    renderAt("/viva?subject=Biology&topic=Photosynthesis");
    expect(await screen.findByDisplayValue("Biology")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Photosynthesis")).toBeInTheDocument();
    expect(viva.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("the optional AI explanation", () => {
  it("is not requested until the student asks; then it is ONE call and the text appears on the cards", async () => {
    backend.knobs.delayMs = 120;
    const { user } = renderAt();
    await screen.findByRole("heading", { name: "Recommended Now" });
    expect(screen.getByText(/When AI is enabled, Google Gemini/)).toBeInTheDocument();
    expect(screen.getByText(/Those facts may be sent to Google for processing/)).toBeInTheDocument();
    expect(screen.getByText(/If AI is disabled or unavailable/)).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const button = screen.getByRole("button", { name: "Explain my priorities" });
    await Promise.all([user.click(button), user.click(button), user.click(button)]);
    expect(await screen.findByText("Writing the explanations…")).toBeInTheDocument();
    expect(await screen.findByText("Start with your weakest topic, then keep the others warm.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(card("Revise Photosynthesis now").getByText("This matters now, so start here.")).toBeInTheDocument();
    expect(card("Revise Photosynthesis now").getByText("In plain words (AI)")).toBeInTheDocument();
    expect(screen.getByText(/Google Gemini-generated, from your own facts only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain again" })).toBeInTheDocument();
  });

  it("when the AI is unavailable the page says so calmly and keeps every recommendation", async () => {
    backend.knobs.explain = { available: false, message: "AI explanation is temporarily unavailable. Your recommendations are still available using your learning data.", overview: null, items: [], isMock: false, model: null };
    const { user } = renderAt();
    await user.click(await screen.findByRole("button", { name: "Explain my priorities" }));
    expect(await screen.findByText(/AI explanation is temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getAllByRole("article").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText("In plain words (AI)")).toBeNull();
  });

  it("a Mock explanation is labelled as such", async () => {
    backend.knobs.explain = { available: true, message: null, overview: "[Demo] canned text", items: [], isMock: true, model: "mock-demo" };
    const { user } = renderAt();
    await user.click(await screen.findByRole("button", { name: "Explain my priorities" }));
    expect(await screen.findByText(/MOCK AI \(demo\)/)).toBeInTheDocument();
  });
});

describe("no data", () => {
  it("a student with no data sees what is needed - and no cards or AI button", async () => {
    useBackend(emptyRecommendations());
    renderAt();
    expect(await screen.findByText("Keep learning to unlock personalized recommendations.")).toBeInTheDocument();
    expect(screen.getByText(/Not enough learning data yet/)).toBeInTheDocument();
    expect(screen.getByText(/Answer at least 5 quiz questions on a topic/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("button", { name: "Explain my priorities" })).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("a student with only a study plan sees the plan card and an explanation of what else is needed", async () => {
    useBackend(planOnly());
    renderAt();
    expect(await screen.findByText(/These come from your study plan only/)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});

describe("dashboard card", () => {
  const renderCard = () =>
    render(
      <MemoryRouter>
        <AuthProvider client={makeClient()}>
          <RecommendedForYou />
        </AuthProvider>
      </MemoryRouter>,
    );

  it("shows the top three - what, why and an action each - with a link to everything", async () => {
    renderCard();
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByRole("heading", { level: 3 }).textContent)).toEqual(["Revise Photosynthesis now", "Fix repeated mistakes in Integration by parts", "Continue: Chemical bonding"]);
    for (const li of items) {
      expect(li.textContent).toContain("Why:");
      expect(within(li).queryAllByRole("link").length + within(li).queryAllByRole("button").length).toBe(1); // exactly one action
    }
    expect(items[0]!.textContent).toContain("You scored 42% across 12 questions");
    expect(within(items[0]!).getByRole("link", { name: /Start Practice/ })).toHaveAttribute("href", "/quiz/new?subject=Biology&topic=Photosynthesis&count=5");
    expect(screen.getByRole("link", { name: "View All →" })).toHaveAttribute("href", "/recommendations");
    expect(backend.calls).toEqual([{ method: "GET", url: "/api/recommendations?limit=3" }]);
  });

  it("invites the student to keep learning when there is nothing yet, and survives an error", async () => {
    useBackend(emptyRecommendations());
    const first = renderCard();
    expect(await screen.findByText("Keep learning to unlock personalized recommendations.")).toBeInTheDocument();
    first.unmount();
    useBackend();
    backend.knobs.failNext = true;
    renderCard();
    expect(await screen.findByText("We couldn't load your recommendations.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("list")).toBeInTheDocument();
  });
});
