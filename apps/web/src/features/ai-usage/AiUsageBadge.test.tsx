import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@copilot/shared";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { AI_USED_EVENT, announceAiUse, isAiRequest, screenUsesAi } from "../../lib/aiUsageEvents";
import { request } from "../../lib/api";
import { z } from "zod";
import { AiUsageBadge } from "./AiUsageBadge";
import { AiUsageNote } from "./AiUsageNote";
import { resetAiUsageStore } from "./store";

const ME = "11111111-1111-4111-8111-111111111111";
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const student = (used: number, limit = 100): AiUsage => ({ unlimited: false, limit, used, remaining: Math.max(0, limit - used), resetsAt: inHours(3) });

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

let usage: AiUsage | "fail";
let usageCalls: number;
beforeEach(() => {
  resetAiUsageStore();
  usage = student(58);
  usageCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === "/api/me/ai-usage") {
        usageCalls++;
        return usage === "fail" ? new Response(JSON.stringify({ message: "boom" }), { status: 500 }) : new Response(JSON.stringify(usage), { status: 200 });
      }
      if (url === "/api/me") return new Response(JSON.stringify({ user: { id: ME, email: "a@x.co" }, profile: { id: ME, displayName: "Ana", timezone: "UTC", role: "student" } }), { status: 200 });
      if (url === "/api/quiz/generate") return new Response(JSON.stringify({ quiz: {} }), { status: 202 });
      return new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetAiUsageStore();
});

const badge = () => screen.findByTestId("ai-usage-badge");
const renderBadge = () =>
  render(
    <MemoryRouter>
      <AuthProvider client={client()}>
        <AiUsageBadge />
      </AuthProvider>
    </MemoryRouter>,
  );

describe("top-bar AI usage pill", () => {
  it("shows what is left, with the details in its label and tooltip, and links to Settings", async () => {
    renderBadge();
    const pill = await badge();
    expect(pill).toHaveTextContent("42/100");
    expect(pill).toHaveAccessibleName("AI uses left today: 42 of 100");
    expect(pill).toHaveAttribute("title", expect.stringMatching(/42 of 100 AI uses left today\. Starts again in about 3 hours/));
    expect(pill).toHaveAttribute("href", "/settings");
  });

  it("turns amber when little is left and says so for assistive technology; red when nothing is", async () => {
    usage = student(85);
    const view = renderBadge();
    expect(await badge()).toHaveClass("bg-amber-50");
    expect(screen.getByText("Only 15 AI uses left today.")).toBeInTheDocument();
    view.unmount();
    resetAiUsageStore();
    usage = student(100);
    renderBadge();
    expect(await badge()).toHaveClass("bg-red-50");
    expect(screen.getByText("You have no AI uses left today.")).toBeInTheDocument();
  });

  it("an administrator sees 'Unlimited', not a count", async () => {
    usage = { unlimited: true, limit: null, used: 0, remaining: null, resetsAt: inHours(3) };
    renderBadge();
    expect(await screen.findByLabelText(/no limit for administrators/i)).toHaveTextContent(/Unlimited/);
    expect(screen.queryByTestId("ai-usage-badge")).not.toBeInTheDocument();
  });

  it("shows nothing at all when the numbers cannot be loaded (it never gets in the way)", async () => {
    usage = "fail";
    renderBadge();
    await waitFor(() => expect(usageCalls).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("ai-usage-badge")).not.toBeInTheDocument();
  });
});

describe("real time", () => {
  it("updates by itself, and flashes, when an AI action happens", async () => {
    renderBadge();
    const pill = await badge();
    expect(pill).toHaveTextContent("42/100");
    expect(pill).not.toHaveClass("ai-flash");
    usage = student(61); // the server charged 3
    act(() => void window.dispatchEvent(new Event(AI_USED_EVENT)));
    await waitFor(() => expect(screen.getByTestId("ai-usage-badge")).toHaveTextContent("39/100"));
    expect(screen.getByTestId("ai-usage-badge")).toHaveClass("ai-flash");
  });

  it("a real AI request through the API helper triggers the refresh; a free one does not", async () => {
    renderBadge();
    await badge();
    const before = usageCalls;
    usage = student(61);
    await request(client(), "/api/quiz/generate", z.object({ quiz: z.object({}) }), { method: "POST", body: "{}" });
    await waitFor(() => expect(screen.getByTestId("ai-usage-badge")).toHaveTextContent("39/100"));
    expect(usageCalls).toBeGreaterThan(before);

    const after = usageCalls;
    await request(client(), "/api/me", z.unknown()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    expect(usageCalls).toBe(after);
  });

  it("several quick actions cause one refresh, not one each", async () => {
    renderBadge();
    await badge();
    const before = usageCalls;
    act(() => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event(AI_USED_EVENT));
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(usageCalls - before).toBe(1);
  });

  it("refreshes once a minute while the tab is visible (another tab may have used some)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderBadge();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    const before = usageCalls;
    usage = student(70);
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(usageCalls).toBeGreaterThan(before);
    expect(screen.getByTestId("ai-usage-badge")).toHaveTextContent("30/100");
  });

  it("the pill and the note beside an AI button share the same live numbers", async () => {
    render(
      <MemoryRouter>
        <AuthProvider client={client()}>
          <AiUsageBadge />
          <AiUsageNote cost={3} />
        </AuthProvider>
      </MemoryRouter>,
    );
    await badge();
    expect(await screen.findByTestId("ai-usage")).toHaveTextContent("42 of 100 AI uses left today");
    usage = student(61);
    act(() => void window.dispatchEvent(new Event(AI_USED_EVENT)));
    await waitFor(() => expect(screen.getByTestId("ai-usage")).toHaveTextContent("39 of 100 AI uses left today"));
    expect(screen.getByTestId("ai-usage-badge")).toHaveTextContent("39/100");
  });
});

describe("where it is shown", () => {
  it("knows which requests are AI actions (the ones the API charges)", () => {
    for (const path of [
      "/api/tutor/conversations/abc/messages",
      "/api/tutor/conversations/abc/regenerate",
      "/api/notes/abc/assistant",
      "/api/notes/abc/assistant/regenerate",
      "/api/quiz/generate",
      "/api/quiz/abc/regenerate",
      "/api/study-plans/generate",
      "/api/study-plans/abc/regenerate",
      "/api/study-sessions/abc/check",
      "/api/viva/sessions",
      "/api/viva/sessions/abc/answer",
      "/api/viva/sessions/abc/next",
      "/api/recommendations/explain",
      "/api/flashcards/decks/generate",
      "/api/mindmaps/generate",
      "/api/mindmaps/abc/regenerate",
    ]) {
      expect(isAiRequest("POST", path), path).toBe(true);
    }
    for (const [method, path] of [
      ["GET", "/api/quiz/generate"],
      ["POST", "/api/flashcards/cards/abc/review"],
      ["POST", "/api/quiz/abc/start"],
      ["POST", "/api/flashcards/decks"],
      ["POST", "/api/viva/sessions/abc/abandon"],
      ["GET", "/api/me/ai-usage"],
      ["POST", "/api/study-sessions/abc/complete"],
    ] as const) {
      expect(isAiRequest(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("announces nothing for a free action", () => {
    const seen = vi.fn();
    window.addEventListener(AI_USED_EVENT, seen);
    announceAiUse("POST", "/api/flashcards/cards/abc/review");
    announceAiUse("POST", "/api/quiz/generate");
    window.removeEventListener(AI_USED_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("is for the screens that ask the AI for something", () => {
    for (const p of ["/tutor", "/tutor/abc", "/notes/abc", "/quiz", "/quiz/new", "/quiz/abc", "/study-plan", "/study-plan/new", "/viva", "/viva/abc", "/flashcards", "/flashcards/abc/study", "/mindmaps", "/mindmaps/abc", "/recommendations", "/settings"]) {
      expect(screenUsesAi(p), p).toBe(true);
    }
    for (const p of ["/dashboard", "/notes", "/progress", "/quiz/attempt/abc", "/quiz/attempt/abc/result", "/admin", "/admin/ai"]) {
      expect(screenUsesAi(p), p).toBe(false);
    }
  });

  it("appears in the top bar on an AI screen and not on the dashboard", async () => {
    const onAi = render(
      <MemoryRouter initialEntries={["/flashcards"]}>
        <AuthProvider client={client()}>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("ai-usage-badge")).toHaveTextContent("42/100");
    onAi.unmount();
    resetAiUsageStore();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider client={client()}>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findAllByRole("navigation", { name: "Main" });
    expect(screen.queryByTestId("ai-usage-badge")).not.toBeInTheDocument();
  });
});
