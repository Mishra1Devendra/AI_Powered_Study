import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "@copilot/shared";
import { AuthProvider } from "../../auth/AuthProvider";
import { AppShell } from "../../components/layout/AppShell";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const QUIZ = "00000000-0000-4000-8000-0000000000a1";

function makeClient() {
  const session = { access_token: "tok-123", user: { id: USER, email: "r@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

const empty = (q: string): SearchResponse => ({ query: q, documents: [], quizzes: [], plans: [], conversations: [], topics: [] });
const found = (q: string): SearchResponse => ({
  query: q,
  documents: [{ id: DOC, title: "Thermodynamics notes", detail: "thermo.pdf", href: `/notes/${DOC}` }],
  quizzes: [{ id: QUIZ, title: "Heat quiz", detail: "Physics · Heat", href: `/quiz/${QUIZ}` }],
  plans: [],
  conversations: [],
  topics: [{ subject: "Physics", topic: "Thermodynamics" }],
});

interface Call {
  url: string;
  auth: string | null;
  signal: AbortSignal | null;
}
let calls: Call[] = [];
let respond: (q: string) => Response | Promise<Response> = (q) => new Response(JSON.stringify(found(q)), { status: 200 });

let where = { pathname: "", state: null as unknown };
function Probe() {
  const l = useLocation();
  where = { pathname: l.pathname, state: l.state };
  return null;
}

function renderShell(path = "/dashboard") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient()}>
        <Probe />
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<div>page content</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

beforeEach(() => {
  calls = [];
  respond = (q) => new Response(JSON.stringify(found(q)), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("/api/search")) {
        calls.push({ url, auth: headers.get("Authorization"), signal: init?.signal ?? null });
        return respond(new URL(url, "http://x").searchParams.get("q") ?? "");
      }
      return new Response(JSON.stringify({ notifications: [], partial: false }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const openSearch = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Search" }));
  return screen.findByRole("dialog", { name: "Search" });
};
const box = () => screen.getByRole("combobox", { name: /Search your notes/ });

describe("global search", () => {
  it("opens from the top bar and from Ctrl+K, focuses the box, and closes with Escape returning focus", async () => {
    const { user } = renderShell();
    const button = await screen.findByRole("button", { name: "Search" });
    await openSearch(user);
    expect(box()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    expect(button).toHaveFocus();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
  });

  it("with nothing typed it offers the pages (no request), and fewer than 2 characters asks for more without searching", async () => {
    const { user } = renderShell();
    const dialog = await openSearch(user);
    for (const page of ["Dashboard", "AI Tutor", "My Notes", "Quiz", "Flashcards", "Mind maps", "Study Plan", "Progress", "Viva", "Recommendations"]) {
      expect(within(dialog).getByRole("option", { name: new RegExp(`^${page}`) })).toBeInTheDocument();
    }
    await user.type(box(), "t");
    expect(within(dialog).getByText(/Type at least 2 characters/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(0);
  });

  it("searches after a short pause with the student's token, shows grouped real results with a loading state first", async () => {
    let release!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => (release = r));
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "thermo");
    expect(await within(dialog).findByRole("status", { name: "Searching your study material" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(1)); // typing 6 letters made ONE request, not six
    expect(calls[0]).toMatchObject({ url: "/api/search?q=thermo", auth: "Bearer tok-123" });
    await act(async () => release(new Response(JSON.stringify(found("thermo")), { status: 200 })));
    expect(await within(dialog).findByRole("group", { name: "Notes & documents" })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: /Thermodynamics notes/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Quizzes" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Subjects & topics" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("status", { name: "Searching your study material" })).toBeNull();
  });

  it("is keyboard friendly: arrows move, Enter opens the document", async () => {
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "thermo");
    await within(dialog).findByRole("group", { name: "Notes & documents" });
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(box()).toHaveAttribute("aria-activedescendant", options[0]!.id);
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    expect(where.pathname).toBe(`/notes/${DOC}`);
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("clicking a quiz opens it", async () => {
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "heat");
    await user.click(await within(dialog).findByRole("option", { name: /Heat quiz/ }));
    expect(where.pathname).toBe(`/quiz/${QUIZ}`);
  });

  it("a topic opens the Tutor with a suggested question that is NOT sent", async () => {
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "thermo");
    await user.click(await within(dialog).findByRole("option", { name: /Physics · Thermodynamics/ }));
    expect(where.pathname).toBe("/tutor");
    expect(where.state).toEqual({ draft: "Help me study Thermodynamics.", subject: "Physics", topic: "Thermodynamics" });
    const sent = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(sent).toHaveLength(0);
  });

  it("says plainly when nothing matches", async () => {
    respond = (q) => new Response(JSON.stringify(empty(q)), { status: 200 });
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "zzzz");
    expect(await within(dialog).findByText(/No results for .zzzz. in your notes, quizzes, plans or topics/)).toBeInTheDocument();
  });

  it("a failure is a calm message with Try again - no raw error text", async () => {
    respond = () => new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 });
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "heat");
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't search right now. Please try again.");
    expect(alert.textContent).not.toMatch(/500|ECONN|SQL|stack/i);
    respond = (q) => new Response(JSON.stringify(found(q)), { status: 200 });
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("option", { name: /Heat quiz/ })).toBeInTheDocument();
  });

  it("a response the app cannot read is also calm (no schema text)", async () => {
    respond = () => new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "heat");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("We couldn't search right now. Please try again.");
  });

  it("a newer keystroke cancels the older request", async () => {
    respond = () => new Promise<Response>(() => undefined);
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "he");
    await waitFor(() => expect(calls).toHaveLength(1));
    await user.type(box(), "at");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);
    expect(within(dialog).getByRole("status", { name: "Searching your study material" })).toBeInTheDocument();
  });

  it("when offline it says so instead of searching", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { user } = renderShell();
    const dialog = await openSearch(user);
    await user.type(box(), "heat");
    expect(await within(dialog).findByText(/You're offline/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("keeps Tab inside the dialog (no keyboard trap, no escape to the page behind)", async () => {
    const { user } = renderShell();
    const dialog = await openSearch(user);
    const close = within(dialog).getByRole("button", { name: "Close" });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(box()).toHaveFocus();
  });
});
