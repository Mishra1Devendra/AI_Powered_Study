import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { emptyDashboard } from "../features/dashboard/sample";
import { AuthProvider } from "./AuthProvider";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function makeSession(): Session {
  return {
    access_token: "token-abc",
    refresh_token: "refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: USER_ID, email: "rahul@example.com" },
  } as Session;
}

/** Minimal in-memory stand-in for the Supabase auth client. */
function makeClient(initial: Session | null, opts: { signUpCreatesSession?: boolean } = {}) {
  let session = initial;
  let listener: ((event: string, s: Session | null) => void) | null = null;
  const auth = {
    getSession: vi.fn(async () => ({ data: { session } })),
    onAuthStateChange: vi.fn((cb: typeof listener) => {
      listener = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    signInWithPassword: vi.fn(async () => {
      session = makeSession();
      listener?.("SIGNED_IN", session);
      return { data: { session }, error: null };
    }),
    signUp: vi.fn(async (_args?: unknown) => {
      if (opts.signUpCreatesSession) {
        session = makeSession();
        listener?.("SIGNED_IN", session);
      }
      return { data: { session: opts.signUpCreatesSession ? session : null, user: { id: USER_ID } }, error: null };
    }),
    signOut: vi.fn(async () => {
      session = null;
      listener?.("SIGNED_OUT", null);
      return { error: null };
    }),
  };
  return { client: { auth } as unknown as SupabaseClient, auth };
}

function renderApp(client: SupabaseClient, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const ME = {
  user: { id: USER_ID, email: "rahul@example.com" },
  profile: { id: USER_ID, displayName: "Rahul", timezone: "UTC" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/dashboard")) return new Response(JSON.stringify(emptyDashboard("Rahul")), { status: 200 });
      return new Response(JSON.stringify(ME), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("protected routes", () => {
  it.each(["/dashboard", "/tutor", "/notes", "/quiz", "/study-plan", "/progress", "/viva", "/settings"])(
    "redirects a signed-out visitor from %s to the login page",
    async (path) => {
      const { client } = makeClient(null);
      renderApp(client, path);
      expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled(); // no API call is ever made without a session
    },
  );

  it("shows a loading state (not protected content) while the session is being restored", () => {
    const { client, auth } = makeClient(null);
    auth.getSession.mockImplementation(() => new Promise(() => {}));
    renderApp(client, "/dashboard");
    expect(screen.getByRole("status")).toHaveTextContent(/checking your session/i);
    expect(screen.queryByText(/good (morning|afternoon|evening)/i)).not.toBeInTheDocument();
  });

  it("lets a signed-in student reach the dashboard and greets them by name", async () => {
    const { client } = makeClient(makeSession());
    renderApp(client, "/dashboard");
    expect(await screen.findByRole("heading", { name: /Rahul/ })).toBeInTheDocument();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
  });

  it("sends a signed-in user away from /login and /signup", async () => {
    for (const path of ["/login", "/signup"]) {
      const { client } = makeClient(makeSession());
      const { unmount } = renderApp(client, path);
      expect(await screen.findByRole("heading", { name: /Rahul/ })).toBeInTheDocument();
      unmount();
    }
  });

  it("shows 404 for unknown routes", async () => {
    const { client } = makeClient(null);
    renderApp(client, "/definitely-not-a-page");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

describe("session persistence", () => {
  it("restores a persisted session on load without asking the user to sign in again", async () => {
    const { client, auth } = makeClient(makeSession());
    renderApp(client, "/dashboard");
    expect(await screen.findByRole("heading", { name: /Rahul/ })).toBeInTheDocument();
    expect(auth.getSession).toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("login", () => {
  it("validates fields before calling Supabase", async () => {
    const { client, auth } = makeClient(null);
    renderApp(client, "/login");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("signs in and lands on the dashboard", async () => {
    const { client, auth } = makeClient(null);
    renderApp(client, "/login");
    await userEvent.type(await screen.findByLabelText("Email"), "  Rahul@Example.com ");
    await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "rahul@example.com", password: "correct-horse-battery" }),
    );
    expect(await screen.findByRole("heading", { name: /Rahul/ })).toBeInTheDocument();
  });

  it("returns the student to the page they originally requested", async () => {
    const { client } = makeClient(null);
    renderApp(client, "/settings");
    await userEvent.type(await screen.findByLabelText("Email"), "rahul@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows one generic message for wrong credentials (no account enumeration)", async () => {
    const { client, auth } = makeClient(null);
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
    } as never);
    renderApp(client, "/login");
    await userEvent.type(await screen.findByLabelText("Email"), "nobody@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
  });
});

describe("signup", () => {
  async function fillSignup(fields: { name?: string; email?: string; password?: string; confirm?: string }) {
    await userEvent.type(await screen.findByLabelText("Your name"), fields.name ?? "Rahul");
    await userEvent.type(screen.getByLabelText("Email"), fields.email ?? "rahul@example.com");
    await userEvent.type(screen.getByLabelText("Password"), fields.password ?? "a-long-enough-password");
    await userEvent.type(screen.getByLabelText("Confirm password"), fields.confirm ?? fields.password ?? "a-long-enough-password");
  }

  it("shows the four fields: name, email, password, confirm password", async () => {
    const { client } = makeClient(null);
    renderApp(client, "/signup");
    for (const label of ["Your name", "Email", "Password", "Confirm password"]) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
  });

  it("rejects short passwords and bad emails client-side", async () => {
    const { client, auth } = makeClient(null);
    renderApp(client, "/signup");
    await fillSignup({ email: "not-an-email", password: "short" });
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByText(/at least 10 characters/i, { selector: "p.text-red-700" })).toBeInTheDocument();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords without calling Supabase", async () => {
    const { client, auth } = makeClient(null);
    renderApp(client, "/signup");
    await fillSignup({ password: "a-long-enough-password", confirm: "a-different-password" });
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("creates the account (name in metadata, confirm password never sent) and lands on the dashboard when no email confirmation is required", async () => {
    const { client, auth } = makeClient(null, { signUpCreatesSession: true });
    renderApp(client, "/signup");
    await fillSignup({});
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: /Rahul/ })).toBeInTheDocument(); // dashboard greeting
    expect(auth.signUp).toHaveBeenCalledOnce();
    const arg = auth.signUp.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(arg).toMatchObject({
      email: "rahul@example.com",
      password: "a-long-enough-password",
      options: { data: { display_name: "Rahul" } },
    });
    expect(arg).not.toHaveProperty("confirmPassword");
    expect(screen.queryByRole("heading", { name: "Check your email" })).not.toBeInTheDocument();
  });

  it("still shows a check-your-email screen if the project requires confirmation (no session returned)", async () => {
    const { client } = makeClient(null, { signUpCreatesSession: false });
    renderApp(client, "/signup");
    await fillSignup({});
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  });

  it("explains when the email is already registered", async () => {
    const { client, auth } = makeClient(null);
    auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 422, code: "user_already_exists", message: "User already registered" } } as never);
    renderApp(client, "/signup");
    await fillSignup({});
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
  });
});

describe("logout", () => {
  it("signs out, returns to login, and the dashboard is no longer reachable", async () => {
    const { client, auth } = makeClient(makeSession());
    renderApp(client, "/settings");
    await screen.findByRole("heading", { name: "Settings" });
    const [signOutButton] = screen.getAllByRole("button", { name: "Sign out" });
    await userEvent.click(signOutButton!);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });
});
