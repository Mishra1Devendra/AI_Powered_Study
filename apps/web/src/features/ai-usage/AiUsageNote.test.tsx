import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@copilot/shared";
import { AuthProvider } from "../../auth/AuthProvider";
import { AiUsageNote, resetPhrase } from "./AiUsageNote";
import { resetAiUsageStore } from "./store";

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: "u", email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

let usage: AiUsage | "fail";
beforeEach(() => {
  resetAiUsageStore();
  usage = { unlimited: false, limit: 100, used: 58, remaining: 42, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === "/api/me/ai-usage" && usage !== "fail") return new Response(JSON.stringify(usage), { status: 200 });
      return new Response(JSON.stringify({ error: "internal_error", message: "boom" }), { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetAiUsageStore();
});

const renderNote = (cost?: number) =>
  render(
    <AuthProvider client={client()}>
      <AiUsageNote {...(cost !== undefined ? { cost } : {})} />
    </AuthProvider>,
  );

describe("AI usage note", () => {
  it("shows how many uses are left today, what this action uses, and when it starts again", async () => {
    renderNote(3);
    const note = await screen.findByTestId("ai-usage");
    expect(note).toHaveTextContent("42 of 100 AI uses left today");
    expect(note).toHaveTextContent("this uses 3");
    expect(note).toHaveTextContent(/Starts again in about 3 hours/);
    expect(screen.getByRole("progressbar", { name: /AI uses spent today/ })).toHaveAttribute("aria-valuenow", "58");
    expect(screen.queryByText(/enough AI uses/i)).not.toBeInTheDocument();
  });

  it("warns, kindly, when the action costs more than what is left", async () => {
    usage = { unlimited: false, limit: 100, used: 99, remaining: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() };
    renderNote(3);
    expect(await screen.findByText(/don't have enough AI uses left for this today \(it needs 3\)/i)).toBeInTheDocument();
  });

  it("says so, and that everything else works, when all of today's uses are spent", async () => {
    usage = { unlimited: false, limit: 100, used: 100, remaining: 0, resetsAt: new Date(Date.now() + 1_800_000).toISOString() };
    renderNote();
    expect(await screen.findByText(/used all of today's AI/i)).toBeInTheDocument();
    expect(screen.getByText(/doesn't use AI still works/i)).toBeInTheDocument();
  });

  it("an administrator sees that there is no limit, not a count", async () => {
    usage = { unlimited: true, limit: null, used: 0, remaining: null, resetsAt: new Date().toISOString() };
    renderNote(3);
    const note = await screen.findByTestId("ai-usage");
    expect(note).toHaveTextContent(/no daily AI limit/i);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("stays silent (and never blocks anything) when the allowance cannot be loaded", async () => {
    usage = "fail";
    renderNote(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("ai-usage")).not.toBeInTheDocument();
  });
});

describe("resetPhrase", () => {
  const now = new Date("2026-10-06T21:00:00Z");
  it("speaks in minutes under an hour and hours otherwise", () => {
    expect(resetPhrase("2026-10-06T21:01:00Z", now)).toBe("about 1 minute");
    expect(resetPhrase("2026-10-06T21:40:00Z", now)).toBe("about 40 minutes");
    expect(resetPhrase("2026-10-07T00:00:00Z", now)).toBe("about 3 hours");
    expect(resetPhrase("2026-10-06T22:00:00Z", now)).toBe("about 1 hour");
    expect(resetPhrase("2026-10-06T20:00:00Z", now)).toBe("about 1 minute"); // already past: never zero or negative
  });
});
