import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthProvider";
import { AccessGate } from "../../features/access/AccessGate";
import { AppShell } from "./AppShell";

const ME = "11111111-1111-4111-8111-111111111111";
let role: "admin" | "student" = "student";
let requests: Array<{ method: string; url: string; body: unknown }>;

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

beforeEach(() => {
  localStorage.clear();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      requests.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/me") return new Response(JSON.stringify({ user: { id: ME, email: "a@x.co" }, profile: { id: ME, displayName: "Alex", timezone: "UTC", role } }), { status: 200 });
      if (url === "/api/bug-reports") return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000b1" }), { status: 201 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderShell(path = "/dashboard") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client()}>
        <Routes>
          <Route element={<AccessGate />}>
            <Route element={<AppShell />}>
              <Route path="/dashboard" element={<p>Dashboard here</p>} />
              <Route path="/admin" element={<p>Admin here</p>} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

const sidebarLinks = async () => {
  const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!; // the sidebar (the second one is the phone bar)
  return within(nav).getAllByRole("link").map((l) => l.textContent?.trim());
};

describe("who sees the admin links", () => {
  it("a student sees no Admin, AI status, Bug reports or Audit log link anywhere in the navigation", async () => {
    role = "student";
    renderShell();
    await screen.findByText("Dashboard here");
    await waitFor(() => expect(requests.some((r) => r.url === "/api/me")).toBe(true));
    const links = await sidebarLinks();
    for (const hidden of ["Admin", "AI status", "Bug reports", "Audit log"]) expect(links).not.toContain(hidden);
    expect(links).toContain("Dashboard");
    // not in the phone bar either, and not as plain text anywhere
    for (const nav of screen.getAllByRole("navigation", { name: "Main" })) expect(within(nav).queryByText(/Bug reports|Audit log|AI status/)).toBeNull();
  });

  it("an admin sees all four, in an Admin group", async () => {
    role = "admin";
    renderShell();
    await waitFor(async () => expect(await sidebarLinks()).toContain("Audit log"));
    const links = await sidebarLinks();
    for (const shown of ["Admin", "AI status", "Bug reports", "Audit log"]) expect(links).toContain(shown);
  });

  it("nothing admin-related is shown while the role is still unknown (it defaults to student)", async () => {
    role = "admin";
    // The role request never answers: the shell must not guess "admin".
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderShell();
    await screen.findByText("Dashboard here");
    expect(await sidebarLinks()).not.toContain("Audit log");
  });
});

describe("everyone can report a bug", () => {
  it.each(["student", "admin"] as const)("a %s has a visible 'Report a bug' button in the sidebar and in the top bar, and it opens one dialog", async (r) => {
    role = r;
    const { user } = renderShell();
    await screen.findByText("Dashboard here");
    const buttons = await screen.findAllByRole("button", { name: "Report a bug" });
    expect(buttons.length).toBeGreaterThanOrEqual(2); // sidebar + top bar
    await user.click(buttons[0]!);
    const dialogs = await screen.findAllByRole("dialog", { name: "Report a bug" });
    expect(dialogs).toHaveLength(1);
  });

  it("a student can actually send a report, and it goes to the API for filing (never to an admin-only route)", async () => {
    role = "student";
    const { user } = renderShell();
    await screen.findByText("Dashboard here");
    await user.click((await screen.findAllByRole("button", { name: "Report a bug" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Report a bug" });
    await user.type(within(dialog).getByLabelText("Short title"), "Button does nothing");
    await user.type(within(dialog).getByLabelText("What happened?"), "Pressing save on the page does nothing at all.");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    await within(dialog).findByText(/your report was sent/i);
    expect(requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual(["/api/bug-reports"]);
    expect(requests.some((r) => r.url.startsWith("/api/admin"))).toBe(false);
  });
});
