import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsResponse } from "@copilot/shared";
import { AuthProvider } from "../../auth/AuthProvider";
import { NotificationsMenu } from "./NotificationsMenu";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const sample: NotificationsResponse = {
  partial: false,
  notifications: [
    { id: "session_missed:a", kind: "session_missed", tone: "attention", title: "You have 2 missed study sessions", body: "Optics (Physics) was planned for 2026-10-04.", href: "/study-plan?session=s1", at: null },
    { id: "quiz_result:q1", kind: "quiz_result", tone: "success", title: "Quiz result: 4/5 (80%)", body: "Heat quiz", href: "/quiz/attempt/q1/result", at: "2026-10-04T09:00:00Z" },
    { id: "recommendation:weak", kind: "recommendation", tone: "info", title: "Review Optics", body: "You scored 20%.", href: "/recommendations", at: null },
  ],
};

function makeClient(id = USER) {
  const session = { access_token: "tok", user: { id, email: "r@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let where = "";
function Probe() {
  where = useLocation().pathname + useLocation().search;
  return null;
}

let respond: () => Response | Promise<Response>;
let requests: string[] = [];

function renderMenu(path = "/progress", userId = USER) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient(userId)}>
        <Probe />
        <Routes>
          <Route path="*" element={<NotificationsMenu />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

beforeEach(() => {
  localStorage.clear();
  requests = [];
  respond = () => new Response(JSON.stringify(sample), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("notifications", () => {
  it("asks for nothing until it is opened (except on the dashboard, where the student lands)", async () => {
    renderMenu("/progress");
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(0);
  });

  it("is ready on the dashboard: the bell shows how many are new", async () => {
    renderMenu("/dashboard");
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
    expect(requests).toEqual(["/api/notifications"]);
  });

  it("opens a panel with real items - kind, how urgent it is in words, and the text", async () => {
    const { user } = renderMenu();
    await user.click(bell());
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    const links = await within(panel).findAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent("Study plan");
    expect(links[0]).toHaveTextContent("Needs attention");
    expect(links[0]).toHaveTextContent("You have 2 missed study sessions");
    expect(links[1]).toHaveTextContent("Result");
    expect(links[2]).toHaveTextContent("Recommendation");
    expect(links[0]).toHaveAttribute("href", "/study-plan?session=s1");
  });

  it("opening an item marks it read (remembered in this browser, per student) and goes there", async () => {
    const { user } = renderMenu();
    await user.click(bell());
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    await user.click(await within(panel).findByRole("link", { name: /Quiz result/ }));
    expect(where).toBe("/quiz/attempt/q1/result");
    expect(JSON.parse(localStorage.getItem(`copilot.notifications.read.${USER}`)!)).toEqual(["quiz_result:q1"]);
    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
  });

  it("'Mark all as read' clears the count; the same items stay read next time", async () => {
    const first = renderMenu();
    await first.user.click(bell());
    await first.user.click(await screen.findByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(`copilot.notifications.read.${USER}`)!)).toHaveLength(3);
  });

  it("read state belongs to the student: another account's browser state does not hide these", async () => {
    localStorage.setItem(`copilot.notifications.read.${OTHER}`, JSON.stringify(sample.notifications.map((n) => n.id)));
    renderMenu("/dashboard", USER);
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
  });

  it("an empty list is a friendly 'all caught up'", async () => {
    respond = () => new Response(JSON.stringify({ notifications: [], partial: false }), { status: 200 });
    const { user } = renderMenu();
    await user.click(bell());
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });

  it("shows a loading state, then says when only part could be loaded", async () => {
    let release!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => (release = r));
    const { user } = renderMenu();
    await user.click(bell());
    expect(await screen.findByRole("status", { name: "Loading your notifications" })).toBeInTheDocument();
    release(new Response(JSON.stringify({ ...sample, partial: true }), { status: 200 }));
    expect(await screen.findByText(/Some updates couldn.t be loaded just now/)).toBeInTheDocument();
  });

  it("a failure is calm and can be retried", async () => {
    respond = () => new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500 });
    const { user } = renderMenu();
    await user.click(bell());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load your notifications. Please try again.");
    respond = () => new Response(JSON.stringify(sample), { status: 200 });
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("link")).toHaveLength(3);
  });

  it("offline: says so and does not ask the server", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { user } = renderMenu();
    await user.click(bell());
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    expect(requests).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("Escape closes it and gives focus back to the bell", async () => {
    const { user } = renderMenu();
    await user.click(bell());
    await screen.findByRole("dialog", { name: "Notifications" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull());
    expect(bell()).toHaveFocus();
  });

  it("works when the browser blocks storage (everything simply shows as unread)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderMenu("/dashboard");
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
