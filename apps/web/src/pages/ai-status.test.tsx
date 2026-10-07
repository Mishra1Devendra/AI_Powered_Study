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
    localPosition: "last",
    countersSince: "2026-10-06T08:00:00.000Z",
    lastAnswered: { service: "Service B", model: "model-b", at: "2026-10-06T09:30:00.000Z" },
    steps: [
      { order: 1, service: "Service A", model: "model-a", where: "online", state: "resting", restingSeconds: 42, usedToday: 1000, limitPerMinute: 30, limitPerDay: 1000, limitNote: "Free plan limits.", lastResult: "rate_limited", lastAt: "2026-10-06T09:00:00.000Z" },
      { order: 2, service: "Service B", model: "model-b", where: "online", state: "ready", restingSeconds: 0, usedToday: 7, limitPerMinute: null, limitPerDay: null, limitNote: "Set per project.", lastResult: "ok", lastAt: "2026-10-06T09:30:00.000Z" },
      { order: 3, service: "Local AI (Ollama)", model: "llama3.2:3b", where: "this_computer", state: "ready", restingSeconds: 0, usedToday: 0, limitPerMinute: null, limitPerDay: null, limitNote: "No service limit.", lastResult: null, lastAt: null },
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
  it("shows which AI answered last, the order, each service's state, usage and free limit", async () => {
    renderPage();
    expect(await screen.findByText(/The last answer came from/)).toHaveTextContent("Service B");
    const list = screen.getByRole("list", { name: "AI services in the order they are tried" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Service A");
    expect(items[0]).toHaveTextContent("Resting (limit reached) · 42s");
    expect(items[0]).toHaveTextContent("1,000 of 1,000 today · up to 30/min");
    expect(items[1]).toHaveTextContent("7 today · no fixed limit");
    expect(items[2]).toHaveTextContent("This computer");
    expect(screen.getByText(/free online services first, the local AI only when they cannot answer/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing paid is ever used/)).toBeInTheDocument();
  });

  it("says so when nothing has answered yet", async () => {
    report = { ...report, lastAnswered: null };
    renderPage();
    expect(await screen.findByText(/No question has been answered since the server started/)).toBeInTheDocument();
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
