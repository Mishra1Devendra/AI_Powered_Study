import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { clearResume, setResume } from "../../features/continue/resumeStore";
import { OFFLINE_MESSAGE } from "../../lib/errors";

const USER = "11111111-1111-4111-8111-111111111111";

function makeClient(signedIn = true) {
  const session = signedIn ? ({ access_token: "tok", user: { id: USER, email: "r@example.com" } } as unknown as Session) : null;
  const signOut = vi.fn(async () => ({ error: null }));
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut,
    },
  } as unknown as SupabaseClient;
  return { client, signOut };
}

let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  clearResume();
  // Every screen is allowed to fail to load here: this file is about the frame around the screens.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderApp(path: string, signedIn = true) {
  const { client, signOut } = makeClient(signedIn);
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user, signOut };
}

const MAIN = ["Dashboard", "AI Tutor", "My Notes", "Quiz", "Flashcards", "Mind maps", "Study Plan", "Progress", "Viva", "Recommendations"];

describe("navigation", () => {
  it("lists the ten modules in order, with Settings kept separate", async () => {
    renderApp("/progress");
    const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!; // the sidebar
    const names = within(nav).getAllByRole("link").map((l) => l.textContent);
    expect(names).toEqual(MAIN);
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Settings" }).length).toBeGreaterThan(0);
  });

  it.each([
    ["/tutor", "AI Tutor"],
    ["/notes", "My Notes"],
    ["/quiz", "Quiz"],
    ["/study-plan", "Study Plan"],
    ["/progress", "Progress"],
    ["/viva", "Viva"],
    ["/recommendations", "Recommendations"],
  ])("%s highlights %s (and only it) as the current page", async (path, name) => {
    renderApp(path);
    const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    const current = within(nav).getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current.map((l) => l.textContent)).toEqual([name]);
  });

  it("a sub-page keeps its module highlighted", async () => {
    renderApp("/quiz/new");
    const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    expect(within(nav).getByRole("link", { name: "Quiz" })).toHaveAttribute("aria-current", "page");
  });

  it("every module is reachable on a phone: four in the bar, the rest (and Settings) under More", async () => {
    const { user } = renderApp("/dashboard");
    const bars = await screen.findAllByRole("navigation", { name: "Main" });
    const bottom = bars[1]!;
    expect(within(bottom).getAllByRole("link").map((l) => l.textContent)).toEqual(["Dashboard", "AI Tutor", "My Notes", "Quiz"]);
    await user.click(within(bottom).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu", { name: "More" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Flashcards", "Mind maps", "Study Plan", "Progress", "Viva", "Recommendations", "Settings", "Report a bug", "Sign out"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "More" })).toBeNull();
    expect(within(bottom).getByRole("button", { name: "More" })).toHaveFocus();
  });

  it("More shows as the current section when a screen from it is open", async () => {
    renderApp("/viva");
    const bottom = (await screen.findAllByRole("navigation", { name: "Main" }))[1]!;
    expect(within(bottom).getByRole("button", { name: "More" }).className).toMatch(/text-brand-600/);
  });

  it("protected screens need a sign-in, and nothing is requested for a signed-out visitor", async () => {
    renderApp("/notes", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(fetched).toHaveLength(0);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("the page has a skip link, a search button and a notifications button", async () => {
    renderApp("/progress");
    expect(await screen.findByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notifications/ })).toBeInTheDocument();
  });
});

describe("connection awareness", () => {
  it("says so (politely, without promising offline use) while offline, and goes away when back online", async () => {
    renderApp("/progress");
    await screen.findAllByRole("navigation", { name: "Main" });
    expect(screen.queryByText(OFFLINE_MESSAGE)).toBeNull();
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(await screen.findByText(OFFLINE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE_MESSAGE).closest("[role=status]")).not.toBeNull();
    expect(OFFLINE_MESSAGE).toBe("You're offline. Some learning features may be unavailable until your connection returns.");
    spy.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(screen.queryByText(OFFLINE_MESSAGE)).toBeNull());
    spy.mockRestore();
  });
});

describe("continue learning shortcut", () => {
  const resume = { kind: "quiz" as const, eyebrow: "Unfinished quiz", title: "Finish Heat quiz", detail: null, cta: "Continue quiz", href: "/quiz/attempt/a1", at: null };

  it("shows nothing at all when there is nothing to continue (no placeholder)", async () => {
    renderApp("/progress");
    await screen.findAllByRole("navigation", { name: "Main" });
    expect(screen.queryByText("Continue learning")).toBeNull();
  });

  it("shows what the dashboard worked out, in the sidebar, as a real link", async () => {
    setResume(USER, resume);
    renderApp("/progress");
    await screen.findAllByRole("navigation", { name: "Main" });
    const link = screen.getByRole("link", { name: /Continue learning\s*Finish Heat quiz/ });
    expect(link).toHaveAttribute("href", "/quiz/attempt/a1");
  });

  it("is never shown to a different student, and expires", async () => {
    setResume("22222222-2222-4222-8222-222222222222", resume);
    renderApp("/progress");
    await screen.findAllByRole("navigation", { name: "Main" });
    expect(screen.queryByText("Finish Heat quiz")).toBeNull();
    clearResume();
    setResume(USER, resume, Date.now() - 11 * 60_000);
    expect(screen.queryByText("Finish Heat quiz")).toBeNull();
  });
});

describe("installable app (PWA basics)", () => {
  const root = resolve(__dirname, "../../..");
  const manifest = JSON.parse(readFileSync(resolve(root, "public/manifest.webmanifest"), "utf8")) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; purpose: string }> };
  const html = readFileSync(resolve(root, "index.html"), "utf8");

  it("has a valid manifest: name, standalone display, start page, theme and icons that exist", () => {
    expect(manifest).toMatchObject({ name: "AI Student Copilot", short_name: "Copilot", display: "standalone", start_url: "/dashboard", scope: "/", theme_color: "#2f55c9" });
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      const bytes = readFileSync(resolve(root, `public${icon.src}`));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // a real PNG
    }
  });

  it("links the manifest, theme colour and icons from the page, and allows full-screen phones", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color" content="#f7f5ef"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain("viewport-fit=cover");
  });

  it("does not register a service worker or push (no offline caching of private data)", () => {
    expect(html).not.toMatch(/serviceWorker|push/i);
    const main = readFileSync(resolve(root, "src/main.tsx"), "utf8");
    expect(main).not.toMatch(/serviceWorker/);
  });
});
