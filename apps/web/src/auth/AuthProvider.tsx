import type { AuthError, Session, SupabaseClient, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LoginInput, SignupInput } from "@copilot/shared";

type Status = "loading" | "authenticated" | "anonymous";

export type SignUpResult = { ok: true; needsEmailConfirmation: boolean } | { ok: false; message: string };
export type ActionResult = { ok: true } | { ok: false; message: string };

interface AuthContextValue {
  status: Status;
  session: Session | null;
  user: User | null;
  /** Supabase client for authenticated calls (kept here so tests can inject a fake). */
  client: SupabaseClient;
  signUp: (input: SignupInput) => Promise<SignUpResult>;
  signIn: (input: LoginInput) => Promise<ActionResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Maps Supabase errors to messages that are helpful but never reveal whether an account exists. */
export function friendlyAuthError(error: AuthError, action: "login" | "signup"): string {
  const code = error.code ?? "";
  if (error.status === 429 || code.includes("rate_limit")) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  if (code === "email_not_confirmed") {
    return "Please confirm your email address first - check your inbox for the link.";
  }
  if (code === "weak_password") return "That password is too weak. Try a longer one.";
  if (code === "user_already_exists") return "An account with this email already exists. Try signing in instead.";
  if (action === "login") return "Incorrect email or password.";
  return "We could not create your account. Please try again.";
}

export function AuthProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let active = true;
    // Restores a persisted session (refreshing it if expired) after a page reload.
    void client.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setStatus(data.session ? "authenticated" : "anonymous");
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      setStatus(next ? "authenticated" : "anonymous");
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const signUp = useCallback<AuthContextValue["signUp"]>(
    async ({ displayName, email, password }) => {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: displayName },
          emailRedirectTo: `${window.location.origin}/login?confirmed=1`,
        },
      });
      if (error) return { ok: false, message: friendlyAuthError(error, "signup") };
      // With email confirmation on, no session is returned. Existing emails behave identically.
      return { ok: true, needsEmailConfirmation: !data.session };
    },
    [client],
  );

  const signIn = useCallback<AuthContextValue["signIn"]>(
    async ({ email, password }) => {
      const { error } = await client.auth.signInWithPassword({ email, password });
      return error ? { ok: false, message: friendlyAuthError(error, "login") } : { ok: true };
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.auth.signOut();
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, user: session?.user ?? null, client, signUp, signIn, signOut }),
    [status, session, client, signUp, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
