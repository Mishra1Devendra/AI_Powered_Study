import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminStudent, AuditEntry, BugReport } from "@copilot/shared";
import { AuthProvider } from "../auth/AuthProvider";
import { PAGE_SIZE, Pagination, pageCount, paginate, rangeText } from "../components/ui/Pagination";
import { AccessGate } from "../features/access/AccessGate";
import AdminPage from "./AdminPage";
import AdminAuditLogPage from "./AdminAuditLogPage";
import AdminBugReportsPage from "./AdminBugReportsPage";

const ME = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let students: AdminStudent[];
let entries: AuditEntry[];
let bugs: BugReport[];
let requests: Array<{ method: string; url: string; body: unknown }>;

const student = (n: number, over: Partial<AdminStudent> = {}): AdminStudent => ({ id: uuid(n), displayName: `Student ${String(n).padStart(2, "0")}`, email: `s${n}@gmail.com`, role: "student", accessStatus: "active", createdAt: "2026-01-01T00:00:00Z", accessChangedAt: null, accessChangedByName: null, lastSignInAt: null, ...over });
const entry = (n: number): AuditEntry => ({ id: uuid(1000 + n), action: "access_paused", actorName: "Alice", targetName: `Target ${String(n).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) - n * 60_000).toISOString() });
const bug = (n: number, over: Partial<BugReport> = {}): BugReport => ({ id: uuid(2000 + n), title: `Report ${String(n).padStart(2, "0")}`, description: `Full description number ${n}. It is longer than the three lines a card shows, so only the dialog has all of it.`, page: "/quiz", type: "bug", severity: "medium", status: "open", reporterName: "Ravi", createdAt: "2026-02-01T10:00:00Z", resolvedAt: null, ...over });

const client = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "a@x.co" } } as unknown as Session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  }) as unknown as SupabaseClient;

beforeEach(() => {
  requests = [];
  students = [];
  entries = [];
  bugs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const path = url.split("?")[0];
      requests.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (path === "/api/me") return json({ user: { id: ME, email: "a@x.co" }, profile: { id: ME, displayName: "Alice", timezone: "UTC", role: "admin" } });
      if (path === "/api/admin/students") return json({ students, total: students.length, truncated: false });
      if (path === "/api/admin/audit-log") return json({ entries, truncated: false, summary: { inRange: { total: entries.length, paused: entries.length, restored: 0, bugChanges: 0 }, actions24h: 0, activeUsers24h: 0, accounts: { total: 1, active: 1, paused: 0, neverSignedIn: 0, dormant30d: 0, signedIn30d: 1 } } });
      if (path === "/api/admin/bug-reports") {
        const n = (s: string) => bugs.filter((b) => b.status === s).length;
        return json({ reports: bugs, counts: { total: bugs.length, open: n("open"), in_progress: n("in_progress"), resolved: n("resolved") }, truncated: false });
      }
      const m = /^\/api\/admin\/bug-reports\/([^/]+)\/status$/.exec(path ?? "");
      if (m) {
        const i = bugs.findIndex((b) => b.id === m[1]);
        bugs[i] = { ...bugs[i]!, status: JSON.parse(String(init!.body)).status };
        return json({ report: bugs[i] });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client()}>
        <Routes>
          <Route element={<AccessGate />}>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/audit-log" element={<AdminAuditLogPage />} />
            <Route path="/admin/bug-reports" element={<AdminBugReportsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

describe("pagination helpers", () => {
  it("20 rows per page, clamped, with a plain 'Showing a-b of n'", () => {
    expect(PAGE_SIZE).toBe(20);
    const rows = Array.from({ length: 45 }, (_, i) => i + 1);
    expect(paginate(rows, 1)).toHaveLength(20);
    expect(paginate(rows, 3)).toEqual([41, 42, 43, 44, 45]);
    expect(paginate(rows, 99)).toEqual([41, 42, 43, 44, 45]); // past the end -> last page
    expect(paginate(rows, 0)[0]).toBe(1); // before the start -> first page
    expect(pageCount(0)).toBe(1);
    expect(pageCount(40)).toBe(2);
    expect(pageCount(41)).toBe(3);
    expect(rangeText(2, 45)).toBe("Showing 21–40 of 45");
    expect(rangeText(3, 45)).toBe("Showing 41–45 of 45");
    expect(rangeText(1, 0)).toBe("No rows");
  });

  it("shows nothing when everything fits on one page, and disables Previous/Next at the ends", async () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={1} total={20} onPage={onPage} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    rerender(<Pagination page={1} total={21} onPage={onPage} />);
    expect(screen.getByRole("button", { name: "Pagination: previous page" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Pagination: next page" }));
    expect(onPage).toHaveBeenCalledWith(2);
    rerender(<Pagination page={2} total={21} onPage={onPage} />);
    expect(screen.getByRole("button", { name: "Pagination: next page" })).toBeDisabled();
  });
});

describe("Users & Access: 20 rows per page", () => {
  it("pages 45 accounts as 20 + 20 + 5, and a new filter returns to page 1", async () => {
    students = Array.from({ length: 45 }, (_, i) => student(i + 1, i % 2 ? { accessStatus: "revoked" } : {}));
    const { user } = renderAt("/admin");
    const table = await screen.findByRole("table", { name: "Accounts" });
    const rows = () => within(table).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(20);
    expect(screen.getByText("Showing 1–20 of 45")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accounts pagination: next page" }));
    expect(screen.getByText("Showing 21–40 of 45")).toBeInTheDocument();
    expect(within(rows()[0]!).getByText("Student 21")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accounts pagination: next page" }));
    expect(rows()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Accounts pagination: next page" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Status"), "revoked"); // 22 paused accounts -> 20 + 2
    await waitFor(() => expect(screen.getByText("Showing 1–20 of 22")).toBeInTheDocument());
    expect(rows()).toHaveLength(20);
  });

  it("shows no pager when there are 20 or fewer accounts", async () => {
    students = Array.from({ length: 20 }, (_, i) => student(i + 1));
    renderAt("/admin");
    await screen.findByRole("table", { name: "Accounts" });
    expect(screen.queryByRole("navigation", { name: "Accounts pagination" })).toBeNull();
  });
});

describe("Audit Log: 20 entries per page", () => {
  it("pages the entries and returns to page 1 when the tab changes", async () => {
    entries = Array.from({ length: 45 }, (_, i) => entry(i + 1));
    const { user } = renderAt("/admin/audit-log");
    const list = await screen.findByRole("list", { name: "Audit log" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    await user.click(screen.getByRole("button", { name: "Audit log pagination: next page" }));
    expect(screen.getByText("Showing 21–40 of 45")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Audit log" })).getAllByRole("listitem")[0]).toHaveTextContent("Target 21");
    await user.click(screen.getByRole("tab", { name: "Access changes" }));
    expect(screen.getByText("Showing 1–20 of 45")).toBeInTheDocument();
  });
});

describe("Bug Tracker: 20 cards per column page, and every card opens", () => {
  it("pages a long column on its own, without moving the other columns", async () => {
    bugs = [...Array.from({ length: 25 }, (_, i) => bug(i + 1)), bug(900, { title: "Working on it", status: "in_progress" })];
    const { user } = renderAt("/admin/bug-reports");
    const open = await screen.findByRole("region", { name: "Open reports" });
    expect(within(open).getAllByRole("listitem")).toHaveLength(20);
    expect(within(open).getByText("Showing 1–20 of 25")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "In progress reports" })).queryByRole("navigation")).toBeNull(); // short column: no pager
    await user.click(within(open).getByRole("button", { name: "Open pagination: next page" }));
    expect(within(open).getAllByRole("listitem")).toHaveLength(5);
    expect(within(screen.getByRole("region", { name: "In progress reports" })).getByText("Working on it")).toBeInTheDocument();
  });

  it("clicking a card opens the full report: everything written, who and when, and status buttons", async () => {
    bugs = [bug(1, { severity: "high", type: "feature", title: "Add a weekly chart" })];
    const { user } = renderAt("/admin/bug-reports");
    await user.click(await screen.findByRole("button", { name: "Open report: Add a weekly chart" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a weekly chart" });
    expect(within(dialog).getByText(/only the dialog has all of it/)).toBeInTheDocument(); // the complete text, not the 3-line preview
    expect(within(dialog).getByText("Ravi")).toBeInTheDocument();
    expect(within(dialog).getByText(/High severity/)).toBeInTheDocument();
    expect(within(dialog).getByText("Feature")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open" })).toBeDisabled(); // already open
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking anywhere on the card opens it too, but its own arrow buttons only move it", async () => {
    bugs = [bug(1, { title: "Quiz freezes" })];
    const { user } = renderAt("/admin/bug-reports");
    const card = (await screen.findByText("Quiz freezes")).closest("li")!;
    await user.click(within(card).getByText(/Full description number 1/));
    expect(await screen.findByRole("dialog", { name: "Quiz freezes" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: 'Move "Quiz freezes" to In progress' }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "In progress reports" })).getByText("Quiz freezes")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull(); // moving did not open it
  });

  it("changing the status from inside the open report moves the card and the dialog keeps showing the new status", async () => {
    bugs = [bug(1, { title: "Quiz freezes" })];
    const { user } = renderAt("/admin/bug-reports");
    await user.click(await screen.findByRole("button", { name: "Open report: Quiz freezes" }));
    const dialog = await screen.findByRole("dialog", { name: "Quiz freezes" });
    await user.click(within(dialog).getByRole("button", { name: "Resolved" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Resolved" })).toBeDisabled());
    expect(within(screen.getByRole("dialog")).getByText(/Resolved/, { selector: "dd" })).toBeInTheDocument();
    expect(requests.find((r) => r.url.endsWith("/status"))!.body).toEqual({ status: "resolved" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    expect(within(screen.getByRole("region", { name: "Resolved reports" })).getByText("Quiz freezes")).toBeInTheDocument();
  });

  it("a new filter sends every column back to page 1", async () => {
    bugs = Array.from({ length: 25 }, (_, i) => bug(i + 1));
    const { user } = renderAt("/admin/bug-reports");
    const open = await screen.findByRole("region", { name: "Open reports" });
    await user.click(within(open).getByRole("button", { name: "Open pagination: next page" }));
    expect(within(open).getByText("Showing 21–25 of 25")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search title or reporter"), "Report 0");
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Open reports" })).getAllByRole("listitem").length).toBeLessThanOrEqual(9));
    expect(screen.queryByText(/Showing 21/)).toBeNull();
  });
});
