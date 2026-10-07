import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_REVOKED_MESSAGE, type AdminStudent } from "@copilot/shared";
import { AuthProvider } from "../../auth/AuthProvider";
import AdminPage from "../../pages/AdminPage";
import { AccessGate } from "./AccessGate";

const ME = "11111111-1111-4111-8111-111111111111";
const S1 = "22222222-2222-4222-8222-222222222222";
const S2 = "33333333-3333-4333-8333-333333333333";

const student = (id: string, name: string, over: Partial<AdminStudent> = {}): AdminStudent => ({ id, displayName: name, email: `${name.toLowerCase()}@gmail.com`, role: "student", accessStatus: "active", createdAt: "2026-01-01T00:00:00Z", accessChangedAt: null, accessChangedByName: null, lastSignInAt: null, ...over });

function makeClient() {
  const session = { access_token: "tok", user: { id: ME, email: "admin@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let role: "admin" | "student" = "admin";
let meStatus = 200;
let list: AdminStudent[];
let calls: Array<{ method: string; url: string; body: unknown }>;

function route(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url === "/api/me") {
    if (meStatus === 403) return json(403, { error: "access_revoked", message: ACCESS_REVOKED_MESSAGE });
    return json(200, { user: { id: ME, email: "admin@example.com" }, profile: { id: ME, displayName: "Alice", timezone: "UTC", role } });
  }
  if (url.startsWith("/api/admin/students?q=")) {
    const q = decodeURIComponent(url.split("q=")[1]!).toLowerCase();
    const rows = list.filter((s) => s.displayName.toLowerCase().includes(q));
    return json(200, { students: rows, total: rows.length, truncated: false });
  }
  if (url === "/api/admin/students") return json(200, { students: list, total: list.length, truncated: false });
  const m = /^\/api\/admin\/students\/([^/]+)\/access$/.exec(url);
  if (m && method === "POST") {
    const status = (JSON.parse(String(init!.body)) as { status: "active" | "revoked" }).status;
    const idx = list.findIndex((s) => s.id === m[1]);
    if (idx < 0) return json(404, { error: "not_found", message: "Student not found." });
    list[idx] = { ...list[idx]!, accessStatus: status };
    return json(200, { student: list[idx] });
  }
  return json(404, { error: "not_found", message: "x" });
}

let where = "";
function Probe() {
  where = useLocation().pathname;
  return null;
}

function renderApp(path = "/admin") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient()}>
        <Probe />
        <Routes>
          <Route element={<AccessGate />}>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/dashboard" element={<p>Dashboard here</p>} />
          </Route>
          <Route path="/login" element={<p>Login here</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

beforeEach(() => {
  role = "admin";
  meStatus = 200;
  list = [student(ME, "Alice", { role: "admin" }), student(S1, "Ravi"), student(S2, "Meera", { accessStatus: "revoked" })];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => route(typeof input === "string" ? input : (input as URL).toString(), init)));
});
afterEach(() => vi.unstubAllGlobals());

describe("Users & Access screen", () => {
  const dataRows = () => within(screen.getByRole("table", { name: "Accounts" })).getAllByRole("row").slice(1); // minus the header row

  it("shows every account with role, status and 'active'; admins have no deactivate button and 'you' is marked", async () => {
    renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    const rows = dataRows();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("(you)")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Admin")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByText("Active")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText(/3 users · 2 active/)).toBeInTheDocument();
  });

  it("shows when each account joined, when it last signed in, and who last changed its access", async () => {
    list[1] = { ...list[1]!, lastSignInAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    list[2] = { ...list[2]!, accessChangedAt: "2026-02-03T10:00:00Z", accessChangedByName: "Alice" };
    renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    const rows = dataRows();
    expect(within(rows[1]!).getByText("2 d ago")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Never")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/Paused by/)).toHaveTextContent("Paused by Alice");
  });

  it("deactivating takes two steps (deactivate, then confirm), sends only the status, and updates the row", async () => {
    const { user } = renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getByRole("button", { name: "Deactivate Ravi" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing sent yet
    await user.click(screen.getByRole("button", { name: "Confirm deactivating Ravi" }));
    await waitFor(() => expect(screen.getByText("Ravi was deactivated.")).toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", url: `/api/admin/students/${S1}/access`, body: { status: "revoked" } }]);
    expect(screen.getByRole("button", { name: "Activate Ravi" })).toBeInTheDocument();
  });

  it("cancel leaves access untouched; activating a paused account is one click", async () => {
    const { user } = renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    await user.click(screen.getByRole("button", { name: "Deactivate Ravi" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Deactivate Ravi" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activate Meera" }));
    await waitFor(() => expect(screen.getByText("Meera was activated again.")).toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ status: "active" }]);
  });

  it("the status and role filters narrow the table without asking the server again", async () => {
    const { user } = renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    const requestsBefore = calls.length;
    await user.selectOptions(screen.getByLabelText("Status"), "revoked");
    expect(dataRows().map((r) => within(r).getByText(/Meera/).textContent)).toEqual(["Meera"]);
    await user.selectOptions(screen.getByLabelText("Status"), "all");
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    expect(dataRows()).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("Role"), "student");
    expect(dataRows()).toHaveLength(2);
    expect(calls.length).toBe(requestsBefore);
  });

  it("search asks the server (debounced) and shows the matches", async () => {
    const { user } = renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    await user.type(screen.getByLabelText("Search by name or email"), "meera");
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(calls.some((c) => c.url === "/api/admin/students?q=meera")).toBe(true);
  });

  it("a student who opens /admin is sent to the dashboard and the admin list is never requested", async () => {
    role = "student";
    renderApp();
    await screen.findByText("Dashboard here");
    expect(where).toBe("/dashboard");
    expect(calls.some((c) => c.url.startsWith("/api/admin"))).toBe(false);
  });

  it("a failed save shows a calm message and keeps the row as it was", async () => {
    const { user } = renderApp();
    await screen.findByRole("table", { name: "Accounts" });
    list = list.filter((s) => s.id !== S2); // the account vanished server-side
    await user.click(screen.getByRole("button", { name: "Activate Meera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
    expect(within(screen.getByRole("table", { name: "Accounts" })).getByText("Paused")).toBeInTheDocument();
  });
});

describe("paused account", () => {
  it("sees one calm screen instead of the app, with a way to sign out", async () => {
    meStatus = 403;
    renderApp("/dashboard");
    expect(await screen.findByRole("heading", { name: "Access paused" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(ACCESS_REVOKED_MESSAGE);
    expect(screen.getByText(/nothing was deleted/i)).toBeInTheDocument();
    expect(screen.queryByText("Dashboard here")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Login here");
  });

  it("an account paused while it is open is switched to that screen on its next request", async () => {
    const { user } = renderApp("/admin");
    await screen.findByRole("table", { name: "Accounts" });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response(JSON.stringify({ error: "access_revoked", message: ACCESS_REVOKED_MESSAGE }), { status: 403 }));
    await user.click(screen.getByRole("button", { name: "Activate Meera" }));
    expect(await screen.findByRole("heading", { name: "Access paused" })).toBeInTheDocument();
  });

  it("a network failure on the role check never locks anyone out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    renderApp("/dashboard");
    expect(await screen.findByText("Dashboard here")).toBeInTheDocument();
  });
});
