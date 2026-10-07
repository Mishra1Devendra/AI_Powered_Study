import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthProvider } from "../auth/AuthProvider";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Skeleton, SkeletonCard, SkeletonList, SkeletonRegion, SkeletonTable, SkeletonText } from "../components/ui/Skeleton";
import SettingsPage from "../pages/SettingsPage";
import { ApiError, NETWORK_MESSAGE, UNREADABLE_MESSAGE, request } from "./api";
import { GENERIC_LOAD_MESSAGE, friendlyMessage } from "./errors";

const USER = "11111111-1111-4111-8111-111111111111";
const client = (token: string | null = "tok") =>
  ({ auth: { getSession: vi.fn(async () => ({ data: { session: token ? ({ access_token: token, user: { id: USER, email: "r@example.com" } } as unknown as Session) : null } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })), signOut: vi.fn(async () => ({ error: null })) } }) as unknown as SupabaseClient;

afterEach(() => vi.unstubAllGlobals());

describe("friendly errors", () => {
  it("server faults, dropped connections and unknown exceptions become plain sentences", () => {
    expect(friendlyMessage(new ApiError(500, "Something went wrong."))).toBe(GENERIC_LOAD_MESSAGE);
    expect(friendlyMessage(new ApiError(502, "x"))).toBe(GENERIC_LOAD_MESSAGE);
    expect(friendlyMessage(new ApiError(0, "anything"))).toBe(NETWORK_MESSAGE);
    expect(friendlyMessage(new ApiError(401, "x"))).toBe("Your session has expired. Please sign in again.");
    for (const raw of [new Error("connect ECONNREFUSED 127.0.0.1:5432"), new TypeError("Failed to fetch"), "boom", null, undefined]) {
      expect(friendlyMessage(raw)).toBe(GENERIC_LOAD_MESSAGE);
    }
    expect(friendlyMessage(new Error("ECONNREFUSED"), "Custom fallback.")).toBe("Custom fallback.");
  });

  it("a message the server wrote for the student (4xx) is kept", () => {
    expect(friendlyMessage(new ApiError(404, "Note not found."))).toBe("Note not found.");
    expect(friendlyMessage(new ApiError(409, "This note is not ready yet."))).toBe("This note is not ready yet.");
  });

  it("an API answer the app cannot read never shows library text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ wrong: "shape" }), { status: 200 })));
    const err = await request(client(), "/api/x", z.object({ expected: z.string() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(UNREADABLE_MESSAGE);
    expect((err as ApiError).message).not.toMatch(/Required|Expected|invalid_type|path/);
  });

  it("a network failure is the standard 'could not reach the server' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await request(client(), "/api/x", z.unknown()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, message: NETWORK_MESSAGE });
  });
});

describe("loading and error building blocks", () => {
  it("skeletons are hidden from assistive technology; the region announces ONE loading message", () => {
    render(
      <SkeletonRegion label="Loading your things">
        <Skeleton className="h-4 w-4" />
        <SkeletonText lines={3} />
        <SkeletonCard action />
        <SkeletonList rows={2} />
        <SkeletonTable rows={2} cols={3} />
      </SkeletonRegion>,
    );
    const region = screen.getByRole("status", { name: "Loading your things" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(within(region).getAllByText("Loading your things")).toHaveLength(1);
    expect(region.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(5);
  });

  it("LoadingState has a shape for cards, lists and forms, each announced once", () => {
    for (const shape of ["cards", "list", "form"] as const) {
      const { unmount } = render(<LoadingState label={`Loading ${shape}…`} shape={shape} />);
      expect(screen.getByRole("status", { name: `Loading ${shape}…` })).toBeInTheDocument();
      unmount();
    }
  });

  it("ErrorState shows the message as an alert and a Retry that works", async () => {
    const retry = vi.fn();
    render(<ErrorState message={GENERIC_LOAD_MESSAGE} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(GENERIC_LOAD_MESSAGE);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("ErrorState without a retry has no button", () => {
    render(<ErrorState message="Nope." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Settings", () => {
  const health = (ai: { provider: string; isMock: boolean; model: string }) => new Response(JSON.stringify({ status: "ok", ai }), { status: 200 });
  const profile = { user: { id: USER, email: "r@example.com" }, profile: { id: USER, displayName: "Rahul Sharma", timezone: "Asia/Kolkata" } };

  function stub(healthResponse: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === "/api/me") return new Response(JSON.stringify(profile), { status: 200 });
        if (url === "/api/me/profile") return new Response(JSON.stringify({ profile: { ...profile.profile, ...(JSON.parse(String(init?.body)) as object) } }), { status: 200 });
        if (url === "/api/health") return healthResponse();
        return new Response("{}", { status: 404 });
      }),
    );
    return calls;
  }
  const renderSettings = () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AuthProvider client={client()}>
          <SettingsPage />
        </AuthProvider>
      </MemoryRouter>,
    );
    return { user };
  };

  it("shows the account, preferences, how the AI works, and sign out - and exposes no secrets", async () => {
    stub(() => health({ provider: "ollama", isMock: false, model: "llama3.2:3b" }));
    renderSettings();
    expect(await screen.findByLabelText("Display name")).toHaveValue("Rahul Sharma");
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Kolkata");
    expect(await screen.findByText("Local AI · llama3.2:3b")).toBeInTheDocument();
    expect(screen.getByText("On this computer")).toBeInTheDocument();
    expect(screen.getByText(/No paid or cloud AI service is used/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/api[_ -]?key|service[_ -]?role|password|secret|token|sk-|postgres/i);
  });

  it("labels the demo AI plainly when the local AI is not running", async () => {
    stub(() => health({ provider: "mock", isMock: true, model: "mock-demo" }));
    renderSettings();
    expect(await screen.findByText("Demo AI (mock)")).toBeInTheDocument();
    expect(screen.getByText(/canned demo text and are labelled that way/)).toBeInTheDocument();
  });

  it("if the AI status can't be read, the rest of Settings still works", async () => {
    stub(() => new Response("nope", { status: 503 }));
    renderSettings();
    expect(await screen.findByText(/The AI status couldn.t be checked right now/)).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
  });

  it("saves the name and time zone together with what was chosen", async () => {
    const calls = stub(() => health({ provider: "ollama", isMock: false, model: "llama3.2:3b" }));
    const { user } = renderSettings();
    const name = await screen.findByLabelText("Display name");
    await user.clear(name);
    await user.type(name, "Rahul S");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH" || c.url === "/api/me/profile")?.body).toEqual({ displayName: "Rahul S", timezone: "Asia/Kolkata" });
  });

  it("an empty name is explained and nothing is sent", async () => {
    const calls = stub(() => health({ provider: "ollama", isMock: false, model: "llama3.2:3b" }));
    const { user } = renderSettings();
    await user.clear(await screen.findByLabelText("Display name"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required");
    expect(calls.filter((c) => c.url === "/api/me/profile")).toEqual([]);
  });
});
