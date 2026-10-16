import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import LoginPage, { confirmationNotice } from "./LoginPage";

const anonymousClient = () =>
  ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(),
    },
  }) as unknown as SupabaseClient;

const renderLogin = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider client={anonymousClient()}>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );

describe("what the sign-in page says after a confirmation-email link", () => {
  it("reads the link's outcome: confirmed, expired/invalid, or nothing special", () => {
    expect(confirmationNotice("?confirmed=1", "")).toMatchObject({ tone: "success" });
    expect(confirmationNotice("", "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")).toMatchObject({ tone: "error" });
    expect(confirmationNotice("?error=access_denied&error_code=otp_expired", "")).toMatchObject({ tone: "error" });
    expect(confirmationNotice("?error_description=Email+link+is+invalid", "")).toMatchObject({ tone: "error" });
    expect(confirmationNotice("", "")).toBeNull();
    expect(confirmationNotice("?next=/dashboard", "#other=1")).toBeNull();
  });

  it("an error beats 'confirmed' (a failed link must never claim success)", () => {
    expect(confirmationNotice("?confirmed=1", "#error_code=otp_expired")?.tone).toBe("error");
  });

  it("shows 'your email is confirmed, please sign in' instead of a silent, unexplained login page", async () => {
    renderLogin("/login?confirmed=1");
    expect(await screen.findByText(/Your email is confirmed\. Please sign in/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("shows the AI-disabled state and Gemini data-processing disclosure on ordinary sign-in", async () => {
    renderLogin("/login");
    await screen.findByLabelText("Email");
    expect(screen.getByText(/AI is disabled for this deployment, so prompts and study content are not currently sent to an AI provider/i)).toBeInTheDocument();
    expect(screen.getByText(/If Gemini is enabled later after model eligibility is verified, relevant content may be sent to Google/i)).toBeInTheDocument();
    expect(screen.getByText(/may be used to improve products and may be reviewed by humans/i)).toBeInTheDocument();
  });

  it("never echoes text from the URL (the message is fixed, not read from the link)", async () => {
    renderLogin("/login?confirmed=1&error_description=<img src=x onerror=alert(1)>");
    expect(await screen.findByRole("alert")).toHaveTextContent("That confirmation link is invalid or has expired.");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});
