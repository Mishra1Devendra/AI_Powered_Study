import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthProvider";
import DashboardPage from "../../pages/DashboardPage";
import { DashboardView } from "./DashboardView";
import { nextStep } from "./FocusCard";
import { firstName, formatMinutes, initials, relativeTime } from "./format";
import { emptyDashboard, sampleDashboard } from "./sample";

const NOW = new Date("2026-10-03T10:00:00");

function renderView(d = emptyDashboard("Rahul Sharma")) {
  return render(
    <MemoryRouter>
      <DashboardView dashboard={d} now={NOW} />
    </MemoryRouter>,
  );
}

describe("dashboard with no data (what a new student really sees)", () => {
  it("greets the student by first name, shows the date and a profile/settings link", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good morning, Rahul");
    expect(screen.getByText("Saturday, 3 October")).toBeInTheDocument();
    const profile = screen.getByRole("link", { name: "Profile and settings" });
    expect(profile).toHaveAttribute("href", "/settings");
    expect(profile).toHaveTextContent("RS");
  });

  it("shows an honest empty state in every data section and invents nothing", () => {
    renderView();
    for (const text of [
      "No study plan for today",
      "No weak topics identified yet",
      "No subjects yet",
      "No activity yet",
      /Nothing tracked yet today/,
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "No study time recorded today" })).toBeInTheDocument();
  });

  it("offers the quick actions as real links, tagging only unbuilt features as Soon", () => {
    renderView();
    const actions = within(screen.getByRole("region", { name: "Quick actions" }));
    const expected: Array<[RegExp, string]> = [
      [/Ask AI Tutor/, "/tutor"],
      [/Upload Notes/, "/notes"],
      [/Start Quiz/, "/quiz"],
      [/Study Plan/, "/study-plan"],
      [/Start Viva/, "/viva"],
    ];
    for (const [name, href] of expected) {
      expect(actions.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    // Every feature in the quick actions is built now.
    expect(actions.queryAllByText("Soon")).toHaveLength(0);
    expect(within(actions.getByRole("link", { name: /Ask AI Tutor/ })).queryByText("Soon")).not.toBeInTheDocument();
  });

  it("points a brand-new student to the AI tutor and shows the learning cycle", () => {
    renderView();
    const focus = within(screen.getByRole("region", { name: /Start with a question/ }));
    expect(focus.getByRole("link", { name: /Ask the AI Tutor/ })).toHaveAttribute("href", "/tutor");
    const cycle = within(screen.getByRole("navigation", { name: "Learning cycle" }));
    expect(cycle.getAllByRole("link").map((l) => l.textContent?.replace(" (coming soon)", ""))).toEqual([
      "Learn",
      "Practice",
      "Test",
      "Analyze",
      "Improve",
    ]);
  });
});

describe("dashboard with data (fixture)", () => {
  it("renders every section from the data", () => {
    renderView(sampleDashboard(NOW));
    expect(screen.getByText("1h 5m")).toBeInTheDocument(); // study time
    expect(screen.getAllByText("2h 30m").length).toBeGreaterThan(0); // planned
    expect(screen.getByText("1/3")).toBeInTheDocument(); // tasks
    expect(screen.getByText("74%")).toBeInTheDocument(); // quiz average
    expect(screen.getAllByText("5 days")).toHaveLength(2); // streak: in Today's progress and in the Progress snapshot
    expect(screen.getByRole("img", { name: "1h 5m studied of 2h 30m planned" })).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Improving")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 done")).toBeInTheDocument();
    expect(screen.getByText("8 of 13 topics completed")).toBeInTheDocument();
    expect(screen.getByText("Calculus checkpoint")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing tracked yet today/)).not.toBeInTheDocument();
  });

  it("gives every progress indicator an accessible name and value", () => {
    renderView(sampleDashboard(NOW));
    const bars = screen.getAllByRole("progressbar");
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const bar of bars) {
      expect(bar).toHaveAccessibleName();
      expect(bar).toHaveAttribute("aria-valuenow");
    }
  });

  it("plan rows expose clear Start/Continue/Completed states", () => {
    renderView(sampleDashboard(NOW));
    expect(screen.getByRole("link", { name: "Continue Electromagnetic induction" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start Organic reaction mechanisms" })).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("the focus card prefers an in-progress session, then the next to-do, then continue-learning", () => {
    const d = sampleDashboard(NOW);
    expect(nextStep(d)).toMatchObject({ title: "Continue Electromagnetic induction", cta: "Continue session" });
    d.plan = d.plan.map((p) => (p.status === "in_progress" ? { ...p, status: "done" as const } : p));
    expect(nextStep(d)).toMatchObject({ title: "Start Organic reaction mechanisms", cta: "Start session" });
    d.plan = [];
    expect(nextStep(d)).toMatchObject({ title: "Integration by substitution", cta: "Continue learning" });
    d.continueLearning = null;
    expect(nextStep(d)).toMatchObject({ cta: "Ask the AI Tutor", to: "/tutor" });
  });

  it("uses a sensible heading structure (one h1, sections are h2)", () => {
    renderView(sampleDashboard(NOW));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(7);
  });
});

describe("format helpers", () => {
  it("formats durations, names and relative time", () => {
    expect(formatMinutes(95)).toBe("1h 35m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(firstName("  Rahul  Sharma ")).toBe("Rahul");
    expect(initials("Rahul Sharma")).toBe("RS");
    expect(initials("devendra")).toBe("D");
    const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    expect(relativeTime(ago(0), NOW)).toBe("Just now");
    expect(relativeTime(ago(5), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(180), NOW)).toBe("3 h ago");
    expect(relativeTime(ago(60 * 24), NOW)).toBe("Yesterday");
    expect(relativeTime(ago(60 * 24 * 3), NOW)).toBe("3 days ago");
  });
});

describe("DashboardPage loading and error states", () => {
  const session = { access_token: "t", user: { id: "u" } } as unknown as Session;
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  } as unknown as SupabaseClient;
  afterEach(() => vi.unstubAllGlobals());

  function renderPage() {
    return render(
      <MemoryRouter>
        <AuthProvider client={client}>
          <DashboardPage />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it("shows a skeleton while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderPage();
    expect(screen.getByRole("status", { name: "Loading your dashboard" })).toBeInTheDocument();
  });

  it("shows an error with a working retry when the API fails", async () => {
    let dashboardCalls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("/api/recommendations")) return new Response(JSON.stringify({ today: "2026-10-03", recommendations: [], summary: { topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false } }), { status: 200 });
      dashboardCalls++;
      return dashboardCalls === 1 ? new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 }) : new Response(JSON.stringify(emptyDashboard("Rahul")), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    // A server fault is explained in plain words (the server's own text is never relied on), with a way to retry.
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong while loading your data. Please try again.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Rahul");
  });

  it("rejects a malformed or unsafe API payload instead of rendering it", async () => {
    const bad = {
      ...emptyDashboard("Rahul"),
      plan: [{ id: "1", subject: "x", topic: "y", startTime: null, durationMinutes: 5, status: "todo", href: "javascript:alert(1)" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(bad), { status: 200 })));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Start y/ })).not.toBeInTheDocument();
  });
});
