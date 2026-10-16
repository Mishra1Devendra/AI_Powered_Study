import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatusReport } from "@copilot/shared";
import { AuthProvider } from "../auth/AuthProvider";
import { AccessGate } from "../features/access/AccessGate";
import AdminAiStatusPage, { usageText } from "./AdminAiStatusPage";

const ME = "11111111-1111-4111-8111-111111111111";
let role: "admin" | "student" = "admin";
let report: AiStatusReport;
let calls: string[];

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

beforeEach(() => {
  role = "admin";
  calls = [];
  report = {
    mode: "free",
    localPosition: null,
    countersSince: "2026-10-06T08:00:00.000Z",
    lastAnswered: null,
    steps: [
      { order: 1, service: "Google Gemini", model: "gemini-2.5-flash-lite (eligibility unverified)", where: "online", state: "not_running", restingSeconds: 0, usedToday: 0, limitPerMinute: null, limitPerDay: null, limitNote: "Free-tier eligibility unverified; provider disabled.", lastResult: null, lastAt: null },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push(url);
      if (url === "/api/me") return new Response(JSON.stringify({ user: { id: ME, email: "a@x.co" }, profile: { id: ME, displayName: "Alice", timezone: "UTC", role } }), { status: 200 });
      if (url === "/api/admin/ai-status") return new Response(JSON.stringify(report), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/admin/ai"]}>
      <AuthProvider client={client()}>
        <Routes>
          <Route element={<AccessGate />}>
            <Route path="/admin/ai" element={<AdminAiStatusPage />} />
            <Route path="/dashboard" element={<p>Dashboard here</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe("admin AI status screen", () => {
  it("shows the disabled sole provider and confirms that no fallback exists", async () => {
    renderPage();
    expect(await screen.findByText(/No question has been answered since the server started/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Configured AI service" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Google Gemini");
    expect(items[0]).toHaveTextContent("Not running");
    expect(items[0]).toHaveTextContent("0 today · no fixed limit");
    expect(screen.getByText(/no local model or provider fallback/i)).toBeInTheDocument();
    expect(screen.getByText(/No other provider is tried/)).toBeInTheDocument();
  });

  it("identifies a deployment where AI is disabled and no content is sent to a provider", async () => {
    report = {
      mode: "disabled",
      localPosition: null,
      countersSince: "2026-10-06T08:00:00.000Z",
      lastAnswered: null,
      steps: [
        { order: 1, service: "AI disabled", model: "none", where: "disabled", state: "not_running", restingSeconds: 0, usedToday: 0, limitPerMinute: null, limitPerDay: null, limitNote: "AI is disabled for this deployment. No prompts or study content are sent to an AI provider.", lastResult: null, lastAt: null },
      ],
    };
    renderPage();
    expect(await screen.findByText(/AI is disabled for this deployment\. No provider was configured or contacted/)).toBeInTheDocument();
    expect(screen.getByText("AI is disabled for this deployment. No prompts or study content are sent to an AI provider.")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("a student never reaches it and never requests it", async () => {
    role = "student";
    renderPage();
    await screen.findByText("Dashboard here");
    expect(calls).not.toContain("/api/admin/ai-status");
  });

  it("formats usage plainly", () => {
    expect(usageText({ usedToday: 12, limitPerDay: 50, limitPerMinute: 20 })).toBe("12 of 50 today · up to 20/min");
    expect(usageText({ usedToday: 0, limitPerDay: null, limitPerMinute: null })).toBe("0 today · no fixed limit");
  });
});
