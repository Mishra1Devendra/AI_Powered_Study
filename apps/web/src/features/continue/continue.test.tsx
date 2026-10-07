import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard, Recommendation, RecommendationsResponse } from "@copilot/shared";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend as makeQuizBackend, qid } from "../../dev/fakeQuizBackend";
import { DashboardView } from "../dashboard/DashboardView";
import { contextMessage } from "../dashboard/DashboardHeader";
import { nextStep } from "../dashboard/FocusCard";
import { emptyDashboard, sampleDashboard } from "../dashboard/sample";
import { QuizFromNoteLink, quizPathFor } from "../notes/AskAiLink";
import { clearResume, readResume, setResume } from "./resumeStore";
import DashboardPage from "../../pages/DashboardPage";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-03T10:00:00");

const resume = (over: Partial<NonNullable<Dashboard["resume"]>> = {}): NonNullable<Dashboard["resume"]> => ({ kind: "quiz", eyebrow: "Unfinished quiz", title: "Finish Heat quiz", detail: "5 questions · Physics · Heat", cta: "Continue quiz", href: "/quiz/attempt/a1", at: "2026-10-03T08:00:00Z", ...over });

const action = (kind: Recommendation["actions"][number]["kind"], over: Partial<Recommendation["actions"][number]> = {}) => ({ kind, label: "Do it", subject: "Physics", topic: "Optics", count: null, draft: null, documentId: null, sessionId: null, ...over });
const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
  id: "WEAK_TOPIC:optics",
  type: "WEAK_TOPIC",
  priority: "high",
  subject: "Physics",
  topic: "Optics",
  title: "Practice Optics",
  reason: "You scored 20% on 8 questions.",
  actionText: "Practice 5 questions",
  primary: "quiz",
  actions: [action("quiz", { label: "Start Practice", count: 5 }), action("tutor", { label: "Ask Tutor", draft: "Explain Optics" })],
  facts: { accuracy: 20, questions: 8, attempts: 2, repeatedMisses: 0, daysSincePracticed: 3, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
  ...over,
});

describe("what to continue (nextStep): real records only, in a fixed order", () => {
  const base = (): Dashboard => ({ ...sampleDashboard(NOW), continueLearning: null, plan: [], resume: null });

  it("what the API says to resume wins over everything else", () => {
    const d = { ...sampleDashboard(NOW), resume: resume() };
    expect(nextStep(d, rec())).toMatchObject({ source: "resume", eyebrow: "Unfinished quiz", title: "Finish Heat quiz", cta: "Continue quiz", to: "/quiz/attempt/a1" });
  });

  it("then today's session, then continue-learning, then the top recommendation, then a start-here prompt", () => {
    const d = base();
    d.plan = [{ id: "p1", subject: "Physics", topic: "Optics", startTime: null, durationMinutes: 30, status: "todo", href: "/study-plan?session=p1" }];
    expect(nextStep(d, rec())).toMatchObject({ source: "plan", cta: "Start session" });
    d.plan = [];
    expect(nextStep(emptyDashboard(), rec())).toMatchObject({ source: "recommendation", eyebrow: "Recommended for you", title: "Practice Optics", cta: "Start Practice", to: "/quiz/new?subject=Physics&topic=Optics&count=5" });
    expect(nextStep(emptyDashboard(), null)).toMatchObject({ source: "empty", to: "/tutor", cta: "Ask the AI Tutor" });
  });

  it("a Tutor recommendation hands over the suggested question as navigation state (nothing is sent)", () => {
    const tutorFirst = rec({ primary: "tutor", actions: [action("tutor", { label: "Ask Tutor", draft: "Explain Optics" })] });
    expect(nextStep(emptyDashboard(), tutorFirst)).toMatchObject({ to: "/tutor", state: { draft: "Explain Optics", subject: "Physics", topic: "Optics" } });
  });

  it("a notes recommendation opens that document", () => {
    const r = rec({ primary: "notes", actions: [action("notes", { label: "Review notes", documentId: "00000000-0000-4000-8000-0000000000d1" })] });
    expect(nextStep(emptyDashboard(), r).to).toBe("/notes/00000000-0000-4000-8000-0000000000d1");
  });
});

describe("the dashboard's one-line summary is honest", () => {
  it("counts what is left today, or says it is done, or falls back to a gentle default", () => {
    const plan = (status: "todo" | "done", minutes: number) => ({ id: String(Math.random()), subject: "S", topic: "T", startTime: null, durationMinutes: minutes, status, href: "/study-plan" });
    expect(contextMessage({ plan: [plan("todo", 30), plan("todo", 45), plan("done", 60)], today: emptyDashboard().today })).toBe("You have 2 study sessions left today (1h 15m).");
    expect(contextMessage({ plan: [plan("todo", 20)], today: emptyDashboard().today })).toBe("You have 1 study session left today (20m).");
    expect(contextMessage({ plan: [plan("done", 20)], today: emptyDashboard().today })).toBe("You've finished today's study plan. Nice work.");
    expect(contextMessage(emptyDashboard())).toBe("Let's make today's study session count.");
  });
});

describe("DashboardView", () => {
  const renderView = (d: Dashboard, topRecommendation: Recommendation | null = null) =>
    render(
      <MemoryRouter>
        <DashboardView dashboard={d} now={NOW} topRecommendation={topRecommendation} />
      </MemoryRouter>,
    );

  it("leads with 'continue learning' and links to exactly where the student left off", () => {
    renderView({ ...emptyDashboard("Rahul"), resume: resume() });
    const hero = within(screen.getByRole("region", { name: "Finish Heat quiz" }));
    expect(hero.getByText("Unfinished quiz")).toBeInTheDocument();
    expect(hero.getByRole("link", { name: /Continue quiz/ })).toHaveAttribute("href", "/quiz/attempt/a1");
  });

  it("shows a streak badge only when the streak is real", () => {
    renderView(sampleDashboard(NOW));
    expect(screen.getByText("5-day study streak")).toBeInTheDocument();
    renderView(emptyDashboard());
    expect(screen.getAllByText(/-day study streak/)).toHaveLength(1);
  });

  it("subject overview uses the same numbers as Progress and writes the level out", () => {
    const d: Dashboard = {
      ...emptyDashboard(),
      progress: {
        studyMinutes: 90,
        studiedToday: 0,
        averageScore: 70,
        attemptsCompleted: 3,
        currentStreak: 2,
        weakTopic: null,
        weakTopics: [],
        viva: null,
        subjectOverview: [
          { subject: "Physics", accuracy: 42, level: "weak", questions: 12, studyMinutes: 60 },
          { subject: "Maths", accuracy: null, level: "insufficient", questions: 3, studyMinutes: 0 },
        ],
      },
    };
    renderView(d);
    const section = within(screen.getByRole("heading", { name: "Subject overview" }).closest("section")!);
    expect(section.getByText("Physics")).toBeInTheDocument();
    expect(section.getByText("42%")).toBeInTheDocument();
    expect(section.getByText(/Weak · 12 quiz questions · 1h studied/)).toBeInTheDocument();
    expect(section.getByText("Not enough quiz data")).toBeInTheDocument(); // never a made-up percentage
    expect(section.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("with no subjects it explains what to do next and offers the action", () => {
    renderView(emptyDashboard());
    const section = within(screen.getByRole("heading", { name: "Subject overview" }).closest("section")!);
    expect(section.getByText("No subjects yet")).toBeInTheDocument();
    expect(section.getByRole("link", { name: "Take a quiz" })).toHaveAttribute("href", "/quiz");
  });

  it("'Today's focus' tells the student how much study is left", () => {
    renderView(sampleDashboard(NOW));
    expect(screen.getByRole("heading", { name: "Today's focus" })).toBeInTheDocument();
    expect(screen.getByText("About 1h 30m of study left today.")).toBeInTheDocument();
  });
});

/* ---------------------------------- the whole page, with the server ---------------------------------- */

const recommendationsPayload = (list: Recommendation[]): RecommendationsResponse => ({ recommendations: list, summary: { topicsAnalyzed: list.length, topicsWithEnoughData: list.length, hasEnoughData: list.length > 0 }, today: "2026-10-03" });

function makeClient() {
  const session = { access_token: "tok", user: { id: USER, email: "r@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let where = { pathname: "", state: null as unknown };
function Probe() {
  const l = useLocation();
  where = { pathname: l.pathname, state: l.state };
  return null;
}

describe("DashboardPage", () => {
  let requests: Array<{ url: string; method: string }>;
  let dashboard: () => Response;
  let recos: () => Response;
  beforeEach(() => {
    requests = [];
    clearResume();
    dashboard = () => new Response(JSON.stringify({ ...emptyDashboard("Rahul"), resume: resume() }), { status: 200 });
    recos = () => new Response(JSON.stringify(recommendationsPayload([rec(), rec({ id: "REPEATED_MISTAKE:x", type: "REPEATED_MISTAKE", title: "Fix repeated mistakes", primary: "tutor", actions: [action("tutor", { label: "Ask Tutor", draft: "Explain the mistakes" })] })])), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: (init?.method ?? "GET").toUpperCase() });
        if (url === "/api/dashboard") return dashboard();
        if (url.startsWith("/api/recommendations")) return recos();
        return new Response(JSON.stringify({ notifications: [], partial: false }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderPage = () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider client={makeClient()}>
          <Probe />
          <Routes>
            <Route path="*" element={<DashboardPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    return { user };
  };

  it("asks the server for recommendations ONCE and shares them between the hero and the card", async () => {
    renderPage();
    expect(await screen.findByRole("region", { name: "Finish Heat quiz" })).toBeInTheDocument();
    await screen.findByText("Fix repeated mistakes");
    expect(requests.filter((r) => r.url.startsWith("/api/recommendations"))).toEqual([{ url: "/api/recommendations?limit=3", method: "GET" }]);
    expect(requests.filter((r) => r.url === "/api/dashboard")).toHaveLength(1);
  });

  it("each recommendation says what, why and gives a button; the Tutor one opens the Tutor with the question ready - and sends nothing", async () => {
    const { user } = renderPage();
    const card = within((await screen.findByRole("heading", { name: "Recommended for You" })).closest("section")!);
    await card.findByText("Fix repeated mistakes");
    expect(card.getAllByText(/^Why:/)).toHaveLength(2);
    await user.click(card.getByRole("button", { name: /Ask Tutor/ }));
    expect(where.pathname).toBe("/tutor");
    expect(where.state).toEqual({ draft: "Explain the mistakes", subject: "Physics", topic: "Optics" });
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]); // following a recommendation creates and sends nothing
  });

  it("a quiz recommendation opens the quiz form pre-filled; nothing is generated", async () => {
    const { user } = renderPage();
    const card = within((await screen.findByRole("heading", { name: "Recommended for You" })).closest("section")!);
    await user.click(await card.findByRole("link", { name: /Start Practice/ }));
    expect(where.pathname).toBe("/quiz/new");
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("with nothing in progress, the hero offers the top recommendation", async () => {
    dashboard = () => new Response(JSON.stringify(emptyDashboard("Rahul")), { status: 200 });
    renderPage();
    const hero = await screen.findByRole("region", { name: "Practice Optics" });
    expect(within(hero).getByText("Recommended for you")).toBeInTheDocument();
    expect(within(hero).getByText(/Nothing starts until you press the button there/)).toBeInTheDocument();
  });

  it("hands the 'continue' shortcut to the rest of the app without another request", async () => {
    renderPage();
    await screen.findByRole("region", { name: "Finish Heat quiz" });
    await waitFor(() => expect(readResume(USER)).toMatchObject({ kind: "quiz", href: "/quiz/attempt/a1" }));
    expect(readResume("22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it("if recommendations fail, the dashboard still works and that card can be retried on its own", async () => {
    recos = () => new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 });
    const { user } = renderPage();
    expect(await screen.findByRole("region", { name: "Finish Heat quiz" })).toBeInTheDocument();
    const card = within((await screen.findByRole("heading", { name: "Recommended for You" })).closest("section")!);
    expect(await card.findByRole("alert")).toHaveTextContent("We couldn't load your recommendations.");
    recos = () => new Response(JSON.stringify(recommendationsPayload([rec()])), { status: 200 });
    await user.click(card.getByRole("button", { name: "Try Again" }));
    expect(await card.findByText("Practice Optics")).toBeInTheDocument();
  });

  it("shows page skeletons while loading, and a calm error with Try again if the dashboard fails", async () => {
    dashboard = () => new Response(JSON.stringify({ message: "relation \"x\" does not exist" }), { status: 500 });
    const { user } = renderPage();
    expect(screen.getByRole("status", { name: "Loading your dashboard" })).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong while loading your data. Please try again.");
    expect(alert.textContent).not.toMatch(/relation|does not exist/);
    dashboard = () => new Response(JSON.stringify(emptyDashboard("Rahul")), { status: 200 });
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Rahul");
  });
});

/* ---------------------------------------- Notes -> Quiz hand-off ---------------------------------------- */

describe("Notes -> Quiz", () => {
  it("the link goes to the quiz form with the document named, and stays inside the preview area when used there", () => {
    expect(quizPathFor("/notes", "abc")).toBe("/quiz/new?document=abc");
    expect(quizPathFor("/dev/notes", "a b")).toBe("/dev/quiz/new?document=a%20b");
    render(
      <MemoryRouter>
        <QuizFromNoteLink note={{ id: "abc", title: "Heat" }} basePath="/notes" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Make a quiz from Heat" })).toHaveAttribute("href", "/quiz/new?document=abc");
  });

  describe("the quiz form", () => {
    const NOTE = { id: qid(7001), title: "Thermodynamics notes", chunkCount: 12, pageCount: 8 };
    let backend: ReturnType<typeof makeQuizBackend>;
    beforeEach(() => {
      backend = makeQuizBackend({ notes: [NOTE] });
      vi.stubGlobal("fetch", backend.fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());
    const open = (url: string) => {
      render(
        <MemoryRouter initialEntries={[url]}>
          <AuthProvider client={makeClient()}>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
    };
    const posts = () => backend.calls.filter((c) => c.method === "POST");

    it("opens with that document already chosen - and creates nothing until Generate is pressed", async () => {
      open(`/quiz/new?document=${NOTE.id}`);
      expect(await screen.findByRole("radio", { name: /Specific document/ })).toBeChecked();
      expect(screen.getByLabelText("Document")).toHaveValue(NOTE.id);
      expect(posts()).toEqual([]);
    });

    it("ignores a document that is not one of the student's ready notes (no way to pre-select someone else's)", async () => {
      open(`/quiz/new?document=${qid(9999)}`);
      expect(await screen.findByRole("radio", { name: /My notes/ })).toBeChecked();
      expect(screen.queryByLabelText("Document")).toBeNull();
      expect(posts()).toEqual([]);
    });
  });
});
