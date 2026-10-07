import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BugReport } from "@copilot/shared";
import { AuthProvider } from "../../auth/AuthProvider";
import AdminAuditLogPage, { auditCsv, describeAudit, rangeBounds } from "../../pages/AdminAuditLogPage";
import AdminBugReportsPage from "../../pages/AdminBugReportsPage";
import { setThemePreference } from "../../lib/theme";
import { AccessGate } from "../access/AccessGate";
import { UserMenu } from "./UserMenu";

const ME = "11111111-1111-4111-8111-111111111111";
const updateUser = vi.fn();
let role: "admin" | "student" = "student";
let requests: Array<{ method: string; url: string; body: unknown }>;
let bugReply: () => Response;
let bugs: BugReport[];

const bug = (id: string, title: string, status: "open" | "in_progress" | "resolved" = "open"): BugReport => ({ id, title, description: `${title} - it happens every time I try.`, page: "/quiz", type: "bug", severity: "medium", status, reporterName: "Ravi", createdAt: "2026-02-01T10:00:00Z", resolvedAt: null });

function makeClient() {
  const session = { access_token: "tok", user: { id: ME, email: "devendra@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
      updateUser,
    },
  } as unknown as SupabaseClient;
}

function route(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, url, body });
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
  if (url === "/api/me") return json(200, { user: { id: ME, email: "devendra@example.com" }, profile: { id: ME, displayName: "Devendra Mishra", timezone: "UTC", role } });
  if (url === "/api/bug-reports") return bugReply();
  if (url === "/api/admin/bug-reports") {
    const n = (s: string) => bugs.filter((b) => b.status === s).length;
    return json(200, { reports: bugs, counts: { total: bugs.length, open: n("open"), in_progress: n("in_progress"), resolved: n("resolved") }, truncated: false });
  }
  const m = /^\/api\/admin\/bug-reports\/([^/]+)\/status$/.exec(url);
  if (m) {
    const i = bugs.findIndex((b) => b.id === m[1]);
    bugs[i] = { ...bugs[i]!, status: body.status };
    return json(200, { report: bugs[i] });
  }
  if (url.split("?")[0] === "/api/admin/audit-log")
    return json(200, {
      entries: [
        { id: "00000000-0000-4000-8000-000000000002", action: "access_restored", actorName: "Devendra Mishra", targetName: "Ravi", createdAt: "2026-02-02T10:00:00Z" },
        { id: "00000000-0000-4000-8000-000000000001", action: "access_paused", actorName: "Devendra Mishra", targetName: "Ravi", createdAt: "2026-02-01T10:00:00Z" },
      ],
      truncated: false,
      summary: { inRange: { total: 2, paused: 1, restored: 1, bugChanges: 0 }, actions24h: 2, activeUsers24h: 1, accounts: { total: 3, active: 3, paused: 0, neverSignedIn: 1, dormant30d: 0, signedIn30d: 2 } },
    });
  return json(404, { error: "not_found", message: "x" });
}

function renderAt(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient()}>
        <Routes>
          <Route element={<AccessGate />}>
            <Route path="/menu" element={<UserMenu />} />
            <Route path="/admin/bug-reports" element={<AdminBugReportsPage />} />
            <Route path="/admin/audit-log" element={<AdminAuditLogPage />} />
            <Route path="/dashboard" element={<p>Dashboard here</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Devendra Mishra/ }));
  return screen.getByRole("menu", { name: "Account" });
}

beforeEach(() => {
  role = "student";
  requests = [];
  bugs = [bug("00000000-0000-4000-8000-0000000000a1", "Quiz page freezes"), bug("00000000-0000-4000-8000-0000000000a2", "Old problem", "resolved")];
  bugReply = () => new Response(JSON.stringify({ id: "00000000-0000-4000-8000-0000000000b1" }), { status: 201 });
  updateUser.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => route(typeof input === "string" ? input : (input as URL).toString(), init)));
});
afterEach(() => vi.unstubAllGlobals());

describe("account menu", () => {
  it("shows the person's name and role on the button, and name, email, role, dark mode, change password, report a bug and sign out when opened", async () => {
    role = "admin";
    const { user } = renderAt("/menu");
    const button = await screen.findByRole("button", { name: /Devendra Mishra/ });
    await waitFor(() => expect(button).toHaveTextContent("Admin"));
    const menu = await openMenu(user);
    expect(within(menu).getByText("devendra@example.com")).toBeInTheDocument();
    expect(within(menu).getAllByText("Admin").length).toBeGreaterThan(0);
    expect(Array.from(menu.querySelectorAll("[role^=menuitem]")).map((e) => e.textContent?.trim())).toEqual(["Dark mode", "Change password", "Report a bug", "Sign out"]);
  });

  it("a student is labelled Student", async () => {
    renderAt("/menu");
    expect(await screen.findByRole("button", { name: /Student/ })).toBeInTheDocument();
  });

  it("the dark mode switch reflects the theme, changes it, and remembers the choice", async () => {
    setThemePreference("light");
    const { user } = renderAt("/menu");
    const menu = await openMenu(user);
    const toggle = within(menu).getByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("copilot-theme")).toBe("dark");
    expect(screen.getByRole("menuitemcheckbox", { name: "Dark mode" })).toHaveAttribute("aria-checked", "true");
  });

  it("Escape closes the menu", async () => {
    const { user } = renderAt("/menu");
    await openMenu(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("change password", () => {
  async function open(user: ReturnType<typeof userEvent.setup>) {
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Change password" }));
    return screen.findByRole("dialog", { name: "Change password" });
  }

  it("checks length and matching before anything is sent", async () => {
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText("New password"), "short");
    await user.type(within(dialog).getByLabelText("Confirm new password"), "short");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText(/at least 10 characters/i, { selector: "p.text-red-700" })).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("New password"));
    await user.type(within(dialog).getByLabelText("New password"), "a-long-enough-password");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText("Passwords do not match")).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("changes the password through the auth service and says so; the password is not sent to our own API", async () => {
    updateUser.mockResolvedValue({ data: {}, error: null });
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText("New password"), "a-long-enough-password");
    await user.type(within(dialog).getByLabelText("Confirm new password"), "a-long-enough-password");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText("Your password was changed.")).toBeInTheDocument();
    expect(updateUser).toHaveBeenCalledWith({ password: "a-long-enough-password" });
    expect(JSON.stringify(requests)).not.toContain("a-long-enough-password");
  });

  it("shows calm wording for an auth error, never the service's own message", async () => {
    updateUser.mockResolvedValue({ data: {}, error: { message: "New password should be different from the old password. (AuthApiError 422 at https://x.supabase.co)" } });
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText("New password"), "a-long-enough-password");
    await user.type(within(dialog).getByLabelText("Confirm new password"), "a-long-enough-password");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Choose a password different from your current one.");
    expect(alert).not.toHaveTextContent(/supabase|AuthApiError/);
  });
});

describe("report a bug", () => {
  async function open(user: ReturnType<typeof userEvent.setup>) {
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Report a bug" }));
    return screen.findByRole("dialog", { name: "Report a bug" });
  }

  it("asks for a title and a description before sending", async () => {
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByText(/short title/i, { selector: "p" })).toBeInTheDocument();
    expect(requests.some((r) => r.url === "/api/bug-reports")).toBe(false);
  });

  it("sends the title, the description and only the screen path, then thanks the person", async () => {
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText("Short title"), "Save button does nothing");
    await user.type(within(dialog).getByLabelText("What happened?"), "I press Save on the settings page and nothing happens.");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByText(/your report was sent/i)).toBeInTheDocument();
    const sent = requests.filter((r) => r.url === "/api/bug-reports");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ title: "Save button does nothing", description: "I press Save on the settings page and nothing happens.", page: "/menu", type: "bug", severity: "medium" });
  });

  it("explains a daily limit calmly and lets the person try later", async () => {
    bugReply = () => new Response(JSON.stringify({ error: "too_many_reports", message: "You've sent 10 reports today. Thank you - please try again tomorrow." }), { status: 429 });
    const { user } = renderAt("/menu");
    const dialog = await open(user);
    await user.type(within(dialog).getByLabelText("Short title"), "Another problem");
    await user.type(within(dialog).getByLabelText("What happened?"), "Something else is wrong with the page.");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("please try again tomorrow");
  });
});

describe("Bug Tracker board", () => {
  const column = (name: string) => screen.getByRole("region", { name: `${name} reports` });

  it("shows stat cards and three columns with each report in the right one", async () => {
    role = "admin";
    bugs = [bug("00000000-0000-4000-8000-0000000000a1", "Quiz page freezes"), bug("00000000-0000-4000-8000-0000000000a2", "Slow tutor", "in_progress"), bug("00000000-0000-4000-8000-0000000000a3", "Old problem", "resolved")];
    renderAt("/admin/bug-reports");
    await screen.findByRole("heading", { name: "Bug Tracker" });
    expect(within(await screen.findByRole("region", { name: "Open reports" })).getByText("Quiz page freezes")).toBeInTheDocument();
    expect(within(column("In progress")).getByText("Slow tutor")).toBeInTheDocument();
    expect(within(column("Resolved")).getByText("Old problem")).toBeInTheDocument();
    expect(screen.getByText("Total reports").closest("div")).toHaveTextContent("3");
  });

  it("moves a report with its arrow buttons (keyboard friendly) and the columns and counts follow", async () => {
    role = "admin";
    bugs = [bug("00000000-0000-4000-8000-0000000000a1", "Quiz page freezes")];
    const { user } = renderAt("/admin/bug-reports");
    await user.click(await screen.findByRole("button", { name: 'Move "Quiz page freezes" to In progress' }));
    await waitFor(() => expect(within(column("In progress")).getByText("Quiz page freezes")).toBeInTheDocument());
    expect(requests.find((r) => r.url.endsWith("/status"))!.body).toEqual({ status: "in_progress" });
    await user.click(screen.getByRole("button", { name: 'Move "Quiz page freezes" to Resolved' }));
    await waitFor(() => expect(within(column("Resolved")).getByText("Quiz page freezes")).toBeInTheDocument());
    expect(within(column("Open")).getByText("Nothing here")).toBeInTheDocument();
  });

  it("dropping a card on another column moves it", async () => {
    role = "admin";
    bugs = [bug("00000000-0000-4000-8000-0000000000a1", "Quiz page freezes")];
    renderAt("/admin/bug-reports");
    const card = (await screen.findByText("Quiz page freezes")).closest("li")!;
    const store: Record<string, string> = {};
    const dataTransfer = { types: ["application/x-bug-report"], setData: (k: string, v: string) => (store[k] = v), getData: (k: string) => store[k] ?? "", effectAllowed: "" };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column("Resolved"), { dataTransfer });
    fireEvent.drop(column("Resolved"), { dataTransfer });
    await waitFor(() => expect(within(column("Resolved")).getByText("Quiz page freezes")).toBeInTheDocument());
    expect(requests.find((r) => r.url.endsWith("/status"))!.body).toEqual({ status: "resolved" });
  });

  it("filters by type, severity and title/reporter in the browser", async () => {
    role = "admin";
    bugs = [
      { ...bug("00000000-0000-4000-8000-0000000000a1", "Quiz page freezes"), severity: "high" },
      { ...bug("00000000-0000-4000-8000-0000000000a2", "Add dark charts"), type: "feature", reporterName: "Meera" },
    ];
    const { user } = renderAt("/admin/bug-reports");
    await screen.findByText("Quiz page freezes");
    await user.selectOptions(screen.getByLabelText("Type"), "feature");
    expect(screen.queryByText("Quiz page freezes")).toBeNull();
    expect(screen.getByText("Add dark charts")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Type"), "all");
    await user.selectOptions(screen.getByLabelText("Severity"), "high");
    expect(screen.queryByText("Add dark charts")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Severity"), "all");
    await user.type(screen.getByLabelText("Search title or reporter"), "meera");
    expect(screen.queryByText("Quiz page freezes")).toBeNull();
    expect(screen.getByText("Add dark charts")).toBeInTheDocument();
    expect(requests.filter((r) => r.url.startsWith("/api/admin/bug-reports")).length).toBe(1); // filters never re-request
  });

  it("a student who opens it never requests the board", async () => {
    renderAt("/admin/bug-reports");
    await screen.findByText("Dashboard here");
    expect(requests.some((r) => r.url.includes("/api/admin/"))).toBe(false);
  });
});

describe("report a bug: type and severity", () => {
  it("sends the chosen type and severity along with the title, description and page", async () => {
    const { user } = renderAt("/menu");
    await user.click(await screen.findByRole("button", { name: /Devendra Mishra/ }));
    await user.click(within(screen.getByRole("menu", { name: "Account" })).getByRole("menuitem", { name: "Report a bug" }));
    const dialog = await screen.findByRole("dialog", { name: "Report a bug" });
    await user.selectOptions(within(dialog).getByLabelText("What is it?"), "feature");
    await user.selectOptions(within(dialog).getByLabelText("How serious is it?"), "high");
    await user.type(within(dialog).getByLabelText("Short title"), "Add a dark chart theme");
    await user.type(within(dialog).getByLabelText("What happened?"), "The charts are hard to read at night.");
    await user.click(within(dialog).getByRole("button", { name: "Send report" }));
    await within(dialog).findByText(/your report was sent/i);
    expect(requests.find((r) => r.url === "/api/bug-reports")!.body).toEqual({ title: "Add a dark chart theme", description: "The charts are hard to read at night.", page: "/menu", type: "feature", severity: "high" });
  });
});

describe("admin audit log", () => {
  it("shows stat cards, tabs and the entries in plain sentences, newest first", async () => {
    role = "admin";
    renderAt("/admin/audit-log");
    const list = await screen.findByRole("list", { name: "Audit log" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Devendra Mishra restored access for Ravi");
    expect(items[1]).toHaveTextContent("Devendra Mishra paused access for Ravi");
    expect(screen.getByText("Active users · 24h").closest("div")).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Adoption")).toBeInTheDocument();
    expect(screen.getByText("Never signed in").closest("div")).toHaveTextContent("1");
  });

  it("the date-range buttons ask the server for that range; 'All time' sends no range", async () => {
    role = "admin";
    const { user } = renderAt("/admin/audit-log");
    await screen.findByRole("list", { name: "Audit log" });
    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(requests.some((r) => /\/api\/admin\/audit-log\?from=.+&to=/.test(r.url))).toBe(true));
    await user.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(requests.filter((r) => r.url === "/api/admin/audit-log").length).toBeGreaterThan(0));
  });

  it("the Access changes tab shows only access entries", async () => {
    role = "admin";
    const { user } = renderAt("/admin/audit-log");
    await screen.findByRole("list", { name: "Audit log" });
    await user.click(screen.getByRole("tab", { name: "Access changes" }));
    expect(within(screen.getByRole("list", { name: "Audit log" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("builds a safe CSV (quotes doubled, spreadsheet formulas neutralised)", () => {
    const csv = auditCsv([{ id: "00000000-0000-4000-8000-000000000001", action: "access_paused", actorName: '=HYPERLINK("x")', targetName: 'Rav"i', createdAt: "2026-02-01T10:00:00Z" }]);
    const [head, row] = csv.split("\r\n");
    expect(head).toBe('"When","Action","By","Account","Summary"');
    expect(row).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(row).toContain('"Rav""i"');
  });

  it("range bounds: today is one local day, 'all time' has none", () => {
    const now = new Date(2026, 1, 11, 15, 30); // Wed 11 Feb 2026 local
    const today = rangeBounds("today", now);
    expect(new Date(today.from!).getDate()).toBe(11);
    expect(Date.parse(today.to!) - Date.parse(today.from!)).toBe(86_400_000);
    expect(new Date(rangeBounds("week", now).from!).getDay()).toBe(1); // Monday
    expect(new Date(rangeBounds("month", now).from!).getDate()).toBe(1);
    expect(rangeBounds("all", now)).toEqual({});
  });

  it("describes every known action and never hides an unknown one", () => {
    expect(describeAudit({ action: "bug_resolved", actorName: "A", targetName: null })).toBe("A marked a bug report as resolved");
    expect(describeAudit({ action: "bug_reopened", actorName: null, targetName: null })).toBe("A deleted account reopened a bug report");
    expect(describeAudit({ action: "something_new", actorName: "A", targetName: null })).toBe("A: something_new");
  });
});
