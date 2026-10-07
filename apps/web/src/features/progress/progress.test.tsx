import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { emptyProgress, makeProgressBackend, richProgress } from "../../dev/fakeProgressBackend";
import { makeBackend as makeQuizBackend } from "../../dev/fakeQuizBackend";
import { DashboardView } from "../dashboard/DashboardView";
import { emptyDashboard, sampleDashboard } from "../dashboard/sample";

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

let where: { pathname: string; search: string; state: unknown } = { pathname: "", search: "", state: null };
/** Every location the router visited (the Tutor clears the hand-off state once it has read it). */
let visits: Array<{ pathname: string; state: unknown }> = [];
function Probe() {
  const l = useLocation();
  where = { pathname: l.pathname, search: l.search, state: l.state };
  visits.push({ pathname: l.pathname, state: l.state });
  return null;
}

function renderAt(path = "/progress", signedIn = true) {
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

let backend: ReturnType<typeof makeProgressBackend>;
function useBackend(respond?: Parameters<typeof makeProgressBackend>[0]) {
  backend = makeProgressBackend(respond);
  vi.stubGlobal("fetch", backend.fetchMock);
}
afterEach(() => vi.unstubAllGlobals());

const region = (name: string) => within(screen.getByRole("region", { name }));
const section = async (title: string) => within((await screen.findByRole("heading", { name: title })).closest("section")!);

describe("access", () => {
  it("a signed-out visitor is sent to login and nothing is requested", async () => {
    useBackend();
    renderAt("/progress", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });

  it("is a real page now (not 'coming soon'), reached from the navigation", async () => {
    useBackend();
    renderAt();
    expect(await screen.findByRole("heading", { level: 1, name: "Progress" })).toBeInTheDocument();
    expect(screen.queryByText(/arrives in Phase/)).toBeNull();
    const nav = screen.getAllByRole("link", { name: /Progress/ })[0]!;
    expect(within(nav).queryByText("Soon")).toBeNull();
  });
});

describe("a student with data", () => {
  it("shows the headline numbers from the server", async () => {
    useBackend();
    renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    expect(region("Study time").getByText("24 sessions completed · last 30 days")).toBeInTheDocument();
    expect(region("Study time").getByText((_, el) => el?.tagName === "P" && /^Up 35% from the 30 days before \(11h 40m\)$/.test(el.textContent ?? ""))).toBeInTheDocument();
    const quiz = region("Quiz performance");
    expect(quiz.getByText("73.3%")).toBeInTheDocument();
    expect(quiz.getByText("average score · 6 quiz attempts")).toBeInTheDocument();
    expect(quiz.getByText("Highest").nextSibling).toHaveTextContent("90%");
    expect(quiz.getByText("Latest").nextSibling).toHaveTextContent("82%");
    const topics = region("Topics");
    expect(topics.getByText("9")).toBeInTheDocument();
    expect(topics.getByText("1 strong")).toBeInTheDocument();
    expect(topics.getByText("1 weak")).toBeInTheDocument();
    const streak = region("Study streak");
    expect(streak.getByText("5 days")).toBeInTheDocument();
    expect(streak.getByText(/Longest: 9 days · 21 study days in total/)).toBeInTheDocument();
  });

  it("charts have a text alternative and use the real dates", async () => {
    useBackend();
    renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    const study = screen.getByRole("img", { name: /Bar chart of study time per day/ });
    expect(study).toBeInTheDocument();
    const trend = screen.getByRole("img", { name: /Line chart of quiz scores over time. 6 finished attempts, latest 82%/ });
    expect(trend).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Quiz scores" });
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getAllByText("Heat basics")).toHaveLength(2);
    expect(within(table).getByText("20 Sept")).toBeInTheDocument();
  });

  it("shows how study time is split by activity type, with percentages as text", async () => {
    useBackend();
    renderAt();
    const how = await screen.findByRole("heading", { name: "How you study" });
    const box = within(how.closest("section")!);
    expect(box.getByText("Learn")).toBeInTheDocument();
    expect(box.getByText(/^41%/)).toBeInTheDocument();
    expect(box.getByText("Revision")).toBeInTheDocument();
    expect(box.getByText("Physics")).toBeInTheDocument();
  });

  it("subjects: accuracy and study time, or 'No performance data yet'", async () => {
    useBackend();
    renderAt();
    const subjects = await section("Subjects");
    expect(subjects.getByRole("heading", { name: "Physics" })).toBeInTheDocument();
    expect(subjects.getByText("70.6%")).toBeInTheDocument();
    expect(subjects.getByText(/No performance data yet \(3 questions so far, 5 needed\)/)).toBeInTheDocument();
  });

  it("topic mastery names the level in words next to the number (never colour alone)", async () => {
    useBackend();
    renderAt();
    const mastery = await section("Topic mastery");
    const weak = mastery.getByText("Electrostatics").closest("li")!;
    expect(within(weak).getByText("37.5%")).toBeInTheDocument();
    expect(within(weak).getByText("Weak")).toBeInTheDocument();
    expect(within(weak).getByRole("meter", { name: "Electrostatics accuracy" })).toHaveAttribute("aria-valuenow", "38");
    const thin = mastery.getByText("Organic chemistry").closest("li")!;
    expect(within(thin).getByText("Insufficient Data")).toBeInTheDocument();
    expect(within(thin).queryByRole("meter")).toBeNull();
    expect(within(thin).getByText(/3 questions answered so far - 5 are needed/)).toBeInTheDocument();
    expect(mastery.getByText(/These are simple guides based on your own quiz answers, not a test of ability/)).toBeInTheDocument();
  });

  it("weak areas offer Practice Topic and Ask AI Tutor, which start nothing by themselves", async () => {
    useBackend();
    const { user } = renderAt();
    const weak = await section("Needs attention");
    expect(weak.getByText("37.5% accuracy · 8 questions answered")).toBeInTheDocument();
    expect(weak.getByRole("link", { name: "Practice topic: Electrostatics" })).toHaveAttribute("href", "/quiz/new?subject=Physics&topic=Electrostatics");
    const before = backend.calls.length;
    await user.click(weak.getByRole("button", { name: "Ask AI Tutor about Electrostatics" }));
    await waitFor(() => expect(where.pathname).toBe("/tutor"));
    const handoff = visits.find((v) => v.pathname === "/tutor" && v.state)!.state as { draft: string; topic: string; subject: string };
    expect(handoff).toMatchObject({ topic: "Electrostatics", subject: "Physics" });
    expect(handoff.draft).toContain("Electrostatics");
    // Progress itself made no request when leaving, and nothing was POSTed anywhere.
    expect(backend.calls.slice(before).filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("improving topics show the real previous and recent accuracy", async () => {
    useBackend();
    renderAt();
    const box = await section("Improving");
    expect(box.getByText("Thermodynamics")).toBeInTheDocument();
    expect(box.getByText("Previous: 58%")).toBeInTheDocument();
    expect(box.getByText("Recent: 76%")).toBeInTheDocument();
  });

  it("recent activity is grouped by the student's own days", async () => {
    useBackend();
    renderAt();
    const box = await section("Recent activity");
    expect(box.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(box.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(box.getByRole("link", { name: /Completed Physics — Thermodynamics/ })).toHaveAttribute("href", "/study-plan?session=s1");
    expect(box.getByRole("link", { name: /Completed quiz — Thermodynamics/ })).toHaveAttribute("href", "/quiz/attempt/a6/result");
    expect(box.getByRole("heading", { name: "Tuesday 13 October" })).toBeInTheDocument();
  });

  it("makes one GET request on load, and no other kind of request", async () => {
    useBackend();
    renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    expect(backend.calls).toEqual([{ method: "GET", url: "/api/progress/summary?range=30d" }]);
  });
});

describe("date range", () => {
  it("defaults to 30 days and asks the server for the chosen range, keeping the old numbers while loading", async () => {
    useBackend((r) => (r === "7d" ? { ...richProgress("7d"), studyTime: { ...richProgress("7d").studyTime, completedSessions: 5, totalMinutes: 210 } } : richProgress(r)));
    const { user } = renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    const group = screen.getByRole("group", { name: "Date range" });
    expect(within(group).getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");

    backend.knobs.delayMs = 150;
    await user.click(within(group).getByRole("button", { name: "7 days" }));
    // Still showing the previous numbers (no skeleton flash) while the new ones load.
    expect(screen.queryByRole("status", { name: "Loading your progress" })).toBeNull();
    expect(region("Study time").getByText(/24 sessions completed/)).toBeInTheDocument();
    expect(await region("Study time").findByText("5 sessions completed · last 7 days")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    expect(backend.calls.at(-1)).toEqual({ method: "GET", url: "/api/progress/summary?range=7d" });

    backend.knobs.delayMs = 0;
    for (const [label, range] of [["90 days", "90d"], ["All time", "all"]] as const) {
      await user.click(within(group).getByRole("button", { name: label }));
      await waitFor(() => expect(backend.calls.at(-1)!.url).toBe(`/api/progress/summary?range=${range}`));
    }
    expect(await region("Study time").findByText(/all time/)).toBeInTheDocument();
    expect(region("Study time").queryByText(/Down|Up .* from/)).toBeNull(); // no comparison for all time
  });

  it("does not request again when the same range is chosen", async () => {
    useBackend();
    const { user } = renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    await user.click(screen.getByRole("button", { name: "30 days" }));
    expect(backend.calls).toHaveLength(1);
  });
});

describe("loading, errors and no data", () => {
  it("shows a skeleton while loading", async () => {
    useBackend();
    backend.knobs.delayMs = 200;
    renderAt();
    expect(await screen.findByRole("status", { name: "Loading your progress" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Study time" })).toBeInTheDocument();
  });

  it("shows a clear error with Retry, and recovers", async () => {
    useBackend();
    backend.knobs.failNext = true;
    const { user } = renderAt();
    expect(await screen.findByText("We couldn't load your progress.")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull(); // no fallback numbers
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Study time" })).toBeInTheDocument();
  });

  it("a brand-new student sees one honest empty state and no statistics", async () => {
    useBackend((r) => emptyProgress(r));
    renderAt();
    expect(await screen.findByRole("heading", { name: "No study data yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open study plan" })).toHaveAttribute("href", "/study-plan");
    expect(screen.getByRole("link", { name: "Take a quiz" })).toHaveAttribute("href", "/quiz");
    expect(screen.queryByRole("region", { name: "Quiz performance" })).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a student with little data sees each missing part explained, with no made-up numbers", async () => {
    useBackend((r) => {
      const e = emptyProgress(r);
      return {
        ...e,
        studyTime: { ...e.studyTime, totalMinutes: 45, completedSessions: 1, activeDays: 1, averageMinutesPerActiveDay: 45, completionRate: 100, byPeriod: [{ start: "2026-10-15", minutes: 45, sessions: 1 }], bySubject: [{ subject: "Physics", minutes: 45, sessions: 1 }], byActivity: [{ activityType: "learn", minutes: 45, sessions: 1, percentage: 100 }] },
        streak: { current: null, longest: null, studyDays: 0, lastStudyDate: null },
        activity: [{ id: "e1", type: "session_completed", at: "2026-10-15T08:00:00.000Z", date: "2026-10-15", title: "Completed Physics — Heat", detail: "45 min", href: null }],
        subjects: [{ subject: "Physics", studyMinutes: 45, completedSessions: 1, quizzes: 0, questions: 0, accuracy: null, level: "insufficient" as const, topics: [] }],
      };
    });
    renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    expect(region("Study streak").getByText("Not enough data yet")).toBeInTheDocument();
    expect(region("Quiz performance").getByText(/No finished quizzes in the last 30 days/)).toBeInTheDocument();
    expect((await section("Quiz scores")).getByText("No finished quizzes yet")).toBeInTheDocument();
    expect((await section("Subjects")).getByText("No performance data yet")).toBeInTheDocument();
    expect((await section("Needs attention")).getByText("Not enough data yet")).toBeInTheDocument();
    expect((await section("Improving")).getByText("Complete more quizzes to see improvement trends.")).toBeInTheDocument();
    expect((await section("Topic mastery")).getByText("No topic data yet")).toBeInTheDocument();
  });

  it("says when topics have enough data but none is weak, or none has improved", async () => {
    useBackend((r) => ({ ...richProgress(r), weakAreas: [], improving: [] }));
    renderAt();
    await screen.findByRole("region", { name: "Quiz performance" });
    expect((await section("Needs attention")).getByText("No weak topics")).toBeInTheDocument();
    expect((await section("Improving")).getByText("No clear improvement yet")).toBeInTheDocument();
  });
});

describe("Practice Topic opens the quiz form with the topic filled in", () => {
  it("prefills the form and generates nothing", async () => {
    const quiz = makeQuizBackend();
    vi.stubGlobal("fetch", quiz.fetchMock);
    renderAt("/quiz/new?subject=Physics&topic=Electrostatics");
    expect(await screen.findByDisplayValue("Physics")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Electrostatics")).toBeInTheDocument();
    expect(quiz.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("dashboard snapshot", () => {
  const renderDashboard = (d = sampleDashboard(new Date("2026-10-03T10:00:00"))) =>
    render(
      <MemoryRouter>
        <DashboardView dashboard={d} now={new Date("2026-10-03T10:00:00")} />
      </MemoryRouter>,
    );

  it("shows the real numbers and links to the full page", () => {
    renderDashboard();
    const box = within(screen.getByRole("heading", { name: "Your progress" }).closest("section")!);
    expect(box.getByText("78%")).toBeInTheDocument();
    expect(box.getByText("6h 20m")).toBeInTheDocument();
    expect(box.getByText("5 days")).toBeInTheDocument();
    expect(box.getByText("Integration — 48%")).toBeInTheDocument();
    expect(box.getByRole("link", { name: "View full progress" })).toHaveAttribute("href", "/progress");
  });

  it("for a new student shows dashes, never zeros or made-up values", () => {
    renderDashboard(emptyDashboard("Rahul"));
    const box = within(screen.getByRole("heading", { name: "Your progress" }).closest("section")!);
    expect(box.getAllByText("No data yet")).toHaveLength(3);
    expect(box.getByText("Finish a few quizzes to see which topics need work.")).toBeInTheDocument();
    expect(box.queryByText(/%/)).toBeNull();
    expect(box.getByRole("link", { name: "View full progress" })).toBeInTheDocument();
  });
});
