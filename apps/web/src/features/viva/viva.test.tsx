import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeVivaBackend } from "../../dev/fakeVivaBackend";

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

function renderAt(path = "/viva", signedIn = true) {
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

let backend: ReturnType<typeof makeVivaBackend>;
function useBackend(opts?: Parameters<typeof makeVivaBackend>[0]) {
  backend = makeVivaBackend(opts);
  vi.stubGlobal("fetch", backend.fetchMock);
}
beforeEach(() => {
  sessionStorage.clear();
  useBackend();
});
afterEach(() => vi.unstubAllGlobals());

const posts = (suffix: string) => backend.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const ANSWER = "Higher temperature gives particles more energy, so more collisions exceed the activation energy and succeed.";

/** Starts a viva straight through the fake API (the form only offers 5, 10 and 15 questions). */
async function seed(questionCount = 3, extra: Record<string, unknown> = {}) {
  const res = await backend.fetchMock("/api/viva/sessions", { method: "POST", body: JSON.stringify({ subject: "Chemistry", topic: "Reaction rates", difficulty: "medium", questionCount, ...extra }) });
  return (await res.json()) as { session: { id: string }; questions: Array<{ id: string }> };
}

async function answerOnce(user: ReturnType<typeof userEvent.setup>, text = ANSWER) {
  fireEvent.change(await screen.findByLabelText("Your answer"), { target: { value: text } });
  await user.click(screen.getByRole("button", { name: "Submit Answer" }));
  await screen.findByRole("button", { name: "Next Question" }, { timeout: 3000 }).catch(() => undefined);
}

describe("access", () => {
  it("a signed-out visitor is sent to login and nothing is requested", async () => {
    renderAt("/viva", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });

  it("is a real page now (not 'coming soon') with the examiner pitch", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { level: 1, name: /Practice explaining concepts like you're answering a real examiner/ })).toBeInTheDocument();
    expect(screen.queryByText(/arrives in Phase/)).toBeNull();
    expect(within(screen.getAllByRole("link", { name: /Viva/ })[0]!).queryByText("Soon")).toBeNull();
  });
});

describe("setup", () => {
  it("defaults to 5 questions (recommended) and Medium, and offers 5 / 10 / 15 and Easy / Medium / Hard", async () => {
    renderAt();
    await screen.findByRole("button", { name: "Start Viva" });
    expect(screen.getByRole("radio", { name: /^5 questions/ })).toBeChecked();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: /questions/ }).map((r) => r.getAttribute("aria-label") ?? r.closest("label")!.textContent)).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Medium/ })).toBeChecked();
    for (const d of ["Easy", "Hard"]) expect(screen.getByRole("radio", { name: new RegExp(d) })).not.toBeChecked();
  });

  it("asks for a subject before starting, and sends nothing", async () => {
    const { user } = renderAt();
    await user.click(await screen.findByRole("button", { name: "Start Viva" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a subject");
    expect(posts("/sessions")).toHaveLength(0);
  });

  it("suggests subjects and topics the student already uses", async () => {
    useBackend({ topics: [{ subject: "Chemistry", topic: "Reaction rates" }] });
    renderAt();
    await screen.findByRole("button", { name: "Start Viva" });
    await waitFor(() => expect(document.querySelector("datalist option[value='Chemistry']")).not.toBeNull());
  });

  it("starts a viva with exactly what was chosen, shows the real preparing state, then the first question", async () => {
    backend.knobs.delayMs = 150;
    const { user } = renderAt();
    await user.type(await screen.findByLabelText("Subject"), "Chemistry");
    await user.type(screen.getByLabelText(/Topic/), "Reaction rates");
    await user.click(screen.getByRole("radio", { name: /Hard/ }));
    await user.click(screen.getByRole("radio", { name: /10 questions/ }));
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByText("Preparing your Viva…")).toBeInTheDocument();
    expect(screen.getByText(/The examiner is preparing your first question/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull(); // no fake percentage
    expect(await screen.findByText("Question 1 of 10", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(posts("/sessions")).toHaveLength(1);
    expect(posts("/sessions")[0]!.body).toEqual({ subject: "Chemistry", topic: "Reaction rates", difficulty: "hard", questionCount: 10 });
    expect(screen.getByRole("heading", { level: 2, name: /Why does increasing temperature/ })).toBeInTheDocument();
    expect(where.pathname).toMatch(/^\/viva\/0000/);
    expect(screen.queryByText(/Activation energy/)).toBeNull(); // the examiner's key points are not shown before answering
  });

  it("a double click cannot start two vivas", async () => {
    backend.knobs.delayMs = 100;
    const { user } = renderAt();
    await user.type(await screen.findByLabelText("Subject"), "Chemistry");
    const button = screen.getByRole("button", { name: "Start Viva" });
    await Promise.all([user.click(button), user.click(button), user.click(button)]);
    await screen.findByText("Question 1 of 5", {}, { timeout: 3000 });
    expect(posts("/sessions")).toHaveLength(1);
  });

  it("shows the server's message when starting fails, and the form is still usable", async () => {
    const { user } = renderAt();
    await user.type(await screen.findByLabelText("Subject"), "Chemistry");
    backend.knobs.failNext = { status: 504, message: "The examiner took too long to respond. Please try again.", error: "examiner_timeout" };
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByText("The examiner took too long to respond. Please try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Chemistry");
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByText("Question 1 of 5", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("labels an offline-demo examiner as MOCK AI (demo)", async () => {
    useBackend({ mock: true });
    const { user } = renderAt();
    expect(await screen.findByText(/your viva topic and answers may be sent to Google Gemini/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Subject"), "Chemistry");
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    await screen.findByText("Question 1 of 5", {}, { timeout: 3000 });
    expect(screen.getByText("MOCK AI (demo)")).toBeInTheDocument();
    expect(screen.queryByText(/LOCAL AI/)).toBeNull();
  });
});

describe("answering", () => {
  it("Submit is disabled until there is an answer, and the answer length is limited", async () => {
    const s = await seed(5);
    const { user } = renderAt(`/viva/${s.session.id}`);
    const submit = await screen.findByRole("button", { name: "Submit Answer" });
    expect(submit).toBeDisabled();
    const box = screen.getByLabelText("Your answer");
    await user.type(box, "   ");
    expect(submit).toBeDisabled();
    fireEvent.change(box, { target: { value: "x".repeat(3001) } });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/3001 \/ 3000 characters/)).toBeInTheDocument();
  });

  it("evaluates with a real 'Evaluating' state, locks the box, then shows scores, feedback, missing concepts and the strong-answer points", async () => {
    const s = await seed(5);
    backend.knobs.delayMs = 150;
    const { user } = renderAt(`/viva/${s.session.id}`);
    await user.type(await screen.findByLabelText("Your answer"), ANSWER);
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Evaluating your answer…");
    expect(screen.getByLabelText("Your answer")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Submit Answer" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Next Question" }, { timeout: 3000 })).toBeInTheDocument();
    for (const label of ["Conceptual understanding", "Completeness", "Clarity", "Confidence (AI estimate)"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText(/\d+\/10/).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("heading", { name: "Feedback" })).toBeInTheDocument();
    expect(screen.getByText(/What a strong answer covers/)).toBeInTheDocument();
    expect(screen.getByText(/Activation energy/)).toBeInTheDocument();
    expect(screen.getByText(/AI-generated evaluation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next Question" })).toHaveFocus();
    // Level is written out with the number, not colour alone.
    expect(screen.getByText(/(Strong|Needs practice|Weak) — \d+%/)).toBeInTheDocument();
  });

  it("clicking Submit repeatedly sends ONE answer", async () => {
    const s = await seed(5);
    backend.knobs.delayMs = 120;
    const { user } = renderAt(`/viva/${s.session.id}`);
    await user.type(await screen.findByLabelText("Your answer"), ANSWER);
    const submit = screen.getByRole("button", { name: "Submit Answer" });
    await Promise.all([user.click(submit), user.click(submit), user.click(submit)]);
    await screen.findByRole("button", { name: "Next Question" }, { timeout: 3000 });
    expect(posts("/answer")).toHaveLength(1);
  });

  it("keeps the typed answer when something goes wrong, and Try again sends it", async () => {
    const s = await seed(5);
    const { user } = renderAt(`/viva/${s.session.id}`);
    await user.type(await screen.findByLabelText("Your answer"), ANSWER);
    backend.knobs.failNext = { status: 504, message: "The examiner took too long to respond. Please try again.", error: "examiner_timeout" };
    await user.click(screen.getByRole("button", { name: "Submit Answer" }));
    expect(await screen.findByText("The examiner took too long to respond. Please try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Your answer")).toHaveValue(ANSWER);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Next Question" }, { timeout: 3000 })).toBeInTheDocument();
    expect(posts("/answer")).toHaveLength(2);
    expect(posts("/answer")[1]!.body).toMatchObject({ answer: ANSWER });
  });

  it("keeps a draft across a page reload", async () => {
    const s = await seed(5);
    const first = renderAt(`/viva/${s.session.id}`);
    await first.user.type(await screen.findByLabelText("Your answer"), "half-written thought");
    document.body.innerHTML = "";
    renderAt(`/viva/${s.session.id}`);
    expect(await screen.findByLabelText("Your answer")).toHaveValue("half-written thought");
  });

  it("'Next Question' asks for the next question and shows its number; a weak answer gets a follow-up", async () => {
    const s = await seed(5);
    const { user } = renderAt(`/viva/${s.session.id}`);
    await answerOnce(user, "I do not know.");
    backend.knobs.delayMs = 120;
    await user.click(await screen.findByRole("button", { name: "Next Question" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Preparing the next question…");
    expect(await screen.findByText("Question 2 of 5", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Follow-up")).toBeInTheDocument();
    expect(posts("/next")).toHaveLength(1);
    expect(screen.getByLabelText("Your answer")).toHaveValue("");
  });
});

describe("a complete viva", () => {
  async function playThrough(user: ReturnType<typeof userEvent.setup>) {
    for (let i = 1; i <= 3; i++) {
      fireEvent.change(await screen.findByLabelText("Your answer"), { target: { value: `${ANSWER} Number ${i}.` } });
      await user.click(screen.getByRole("button", { name: "Submit Answer" }));
      if (i < 3) await user.click(await screen.findByRole("button", { name: "Next Question" }, { timeout: 3000 }));
    }
    return screen.findByText("Overall score", {}, { timeout: 4000 });
  }

  it("ends with the results: overall score, breakdown, strong areas, improvements and a review of every answer", async () => {
    const s = await seed(3);
    const { user } = renderAt(`/viva/${s.session.id}`);
    await playThrough(user);
    expect(screen.getByLabelText(/Overall score \d+ out of 100/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Performance breakdown" })).toBeInTheDocument();
    for (const label of ["Conceptual understanding", "Completeness", "Clarity", "Confidence (AI estimate)"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Strong areas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needs improvement" })).toBeInTheDocument();
    expect(screen.getByText(/40% understanding \+ 30% completeness \+ 20% clarity \+ 10% confidence/)).toBeInTheDocument();
    expect(screen.getByText(/not a validated measure/)).toBeInTheDocument();
    const review = within(screen.getByRole("heading", { name: "Review your answers" }).closest("section")!);
    expect(review.getAllByRole("heading", { level: 3, name: /Question \d/ })).toHaveLength(3);
    expect(review.getAllByText("Your answer")).toHaveLength(3);
    expect(review.getByText(`${ANSWER} Number 2.`)).toBeInTheDocument();
    expect(review.getAllByText("Feedback").length).toBe(3);
    expect(posts("/answer")).toHaveLength(3);
    expect(backend.vivas[0]!.session).toMatchObject({ status: "completed" });
  });

  it("a finished viva can be opened again from history, and its score matches", async () => {
    const done = backend.addCompleted({ subject: "Physics", topic: "Thermodynamics", scores: [80, 60, 100] });
    const { user } = renderAt();
    const list = await screen.findByRole("heading", { name: "Your vivas" });
    const card = within(list.closest("section")!).getByRole("link", { name: /Physics/ });
    expect(card).toHaveTextContent("Needs practice — 80%".replace("Needs practice", "Strong"));
    expect(card).toHaveTextContent("3 questions");
    await user.click(card);
    expect(await screen.findByText("Overall score")).toBeInTheDocument();
    expect(where.pathname).toBe(`/viva/${done.session.id}`);
    expect(screen.getByLabelText("Overall score 80 out of 100")).toBeInTheDocument();
  });

  it("Practice Again creates a NEW viva with the same settings and keeps the old one", async () => {
    const done = backend.addCompleted({ subject: "Physics", topic: "Thermodynamics", difficulty: "hard", scores: [70, 70, 70, 70, 70] });
    const { user } = renderAt(`/viva/${done.session.id}`);
    await user.click(await screen.findByRole("button", { name: "Practice Again" }));
    await waitFor(() => expect(where.pathname).not.toBe(`/viva/${done.session.id}`));
    expect(posts("/sessions")[0]!.body).toEqual({ subject: "Physics", topic: "Thermodynamics", difficulty: "hard", questionCount: 5 });
    expect(await screen.findByText("Question 1 of 5", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(backend.vivas).toHaveLength(2);
    expect(backend.vivas[0]!.session).toMatchObject({ id: done.session.id, status: "completed", score: 70 });
  });

  it("Ask AI Tutor opens the Tutor with the concept filled in and sends nothing", async () => {
    const done = backend.addCompleted({ subject: "Chemistry", topic: "Rates", scores: [40, 40, 40] });
    const { user } = renderAt(`/viva/${done.session.id}`);
    const needs = within((await screen.findByRole("heading", { name: "Needs improvement" })).closest("div")!);
    const before = backend.calls.length;
    await user.click(needs.getAllByRole("button", { name: /Ask AI Tutor about/ })[0]!);
    await waitFor(() => expect(where.pathname).toBe("/tutor"));
    const handoff = visits.find((v) => v.pathname === "/tutor" && v.state)!.state as { draft: string; subject: string; topic: string };
    expect(handoff).toMatchObject({ subject: "Chemistry" });
    expect(handoff.draft).toContain(handoff.topic);
    expect(backend.calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a MOCK viva's results say so", async () => {
    const done = backend.addCompleted({ subject: "Chemistry", scores: [50, 50, 50], isMock: true });
    renderAt(`/viva/${done.session.id}`);
    expect(await screen.findByText("MOCK AI (demo)")).toBeInTheDocument();
  });
});

describe("ending, history and ownership", () => {
  it("End viva asks first, keeps the answers, and the viva shows as abandoned in history", async () => {
    const s = await seed(5);
    const { user } = renderAt(`/viva/${s.session.id}`);
    await user.click(await screen.findByRole("button", { name: "End viva" }));
    const dialog = screen.getByRole("dialog", { name: "End this viva?" });
    expect(dialog).toHaveTextContent("does not get a score");
    await user.click(within(dialog).getByRole("button", { name: "End viva" }));
    await waitFor(() => expect(where.pathname).toBe("/viva"));
    expect(backend.vivas[0]!.session.status).toBe("abandoned");
    const list = await screen.findByRole("heading", { name: "Your vivas" });
    expect(within(list.closest("section")!).getByText("Abandoned")).toBeInTheDocument();
  });

  it("an unfinished viva can be continued from history", async () => {
    const s = await seed(5);
    const { user } = renderAt();
    const list = await screen.findByRole("heading", { name: "Your vivas" });
    const card = within(list.closest("section")!).getByRole("link", { name: /Chemistry/ });
    expect(card).toHaveTextContent("0 of 5 answered");
    await user.click(within(card).getByText("Continue →"));
    expect(await screen.findByText("Question 1 of 5")).toBeInTheDocument();
    expect(where.pathname).toBe(`/viva/${s.session.id}`);
  });

  it("an empty history is explained, not faked", async () => {
    renderAt();
    expect(await screen.findByText("No vivas yet")).toBeInTheDocument();
  });

  it("another student's (or a missing) viva shows a clear message", async () => {
    renderAt("/viva/00000000-0000-4000-8000-000000000777");
    expect(await screen.findByText("This viva doesn't exist, or it isn't yours.")).toBeInTheDocument();
  });
});

describe("dashboard card and progress section", () => {
  it("the dashboard card shows the real last score, or invites a first viva (no score invented)", async () => {
    const { DashboardView } = await import("../dashboard/DashboardView");
    const { emptyDashboard, sampleDashboard } = await import("../dashboard/sample");
    const view = (d: ReturnType<typeof emptyDashboard>) =>
      render(
        <MemoryRouter>
          <DashboardView dashboard={d} now={new Date("2026-10-03T10:00:00")} />
        </MemoryRouter>,
      );
    const first = view(sampleDashboard(new Date("2026-10-03T10:00:00")));
    const card = within(screen.getByRole("heading", { name: "AI Viva" }).closest("section")!);
    expect(card.getByText("Practice explaining what you know.")).toBeInTheDocument();
    expect(card.getByText("78%")).toBeInTheDocument();
    expect(card.getByRole("link", { name: "Start Viva" })).toHaveAttribute("href", "/viva");
    first.unmount();
    view(emptyDashboard("Rahul"));
    const empty = within(screen.getByRole("heading", { name: "AI Viva" }).closest("section")!);
    expect(empty.getByText("Test your understanding with an AI Viva.")).toBeInTheDocument();
    expect(empty.queryByText(/Last score/)).toBeNull();
    expect(empty.getByRole("link", { name: "Start Viva" })).toHaveAttribute("href", "/viva");
  });

  it("Progress shows a separate Viva performance section, with an empty state when there is none", async () => {
    const { VivaSection } = await import("../progress/VivaSection");
    const { richProgress, emptyProgress } = await import("../../dev/fakeProgressBackend");
    const view = (d: ReturnType<typeof richProgress>) =>
      render(
        <MemoryRouter>
          <VivaSection data={d} />
        </MemoryRouter>,
      );
    const rich = view(richProgress("30d"));
    const box = within(screen.getByRole("heading", { name: "Viva performance" }).closest("section")!);
    expect(box.getByText("71.7%")).toBeInTheDocument();
    expect(box.getByText("average viva score")).toBeInTheDocument();
    expect(box.getAllByText("Physics", { exact: false }).length).toBeGreaterThan(0);
    expect(box.getByText(/Quiz results are shown separately/)).toBeInTheDocument();
    expect(box.getAllByText(/(Strong|Needs practice|Weak) — \d+%/).length).toBeGreaterThan(0);
    rich.unmount();
    view(emptyProgress("30d"));
    expect(screen.getByText("No completed viva yet")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
