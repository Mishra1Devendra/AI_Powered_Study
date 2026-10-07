import { createContext, useContext, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import type { Role } from "@copilot/shared";
import { ACCESS_REVOKED_MESSAGE } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { Logo } from "../../components/ui/Logo";
import { ACCESS_REVOKED_EVENT, ApiError, fetchMe } from "../../lib/api";
import { clearResume } from "../continue/resumeStore";

interface RoleState {
  role: Role;
  /** False until the API has said who this account is (or failed to). Screens that depend on the role wait for it. */
  ready: boolean;
  /** For the account menu. Empty until the profile has loaded. */
  displayName: string;
  email: string | null;
}
const RoleContext = createContext<RoleState>({ role: "student", ready: true, displayName: "", email: null });

/** The signed-in account's role, for showing or hiding admin links. The API enforces the same rule on every request. */
export const useRole = (): Role => useContext(RoleContext).role;
/** Like useRole, plus whether the answer is known yet. */
export const useRoleState = (): RoleState => useContext(RoleContext);

function AccessPaused() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <Logo className="mb-8" />
      <h1 className="text-2xl font-semibold tracking-tight">Access paused</h1>
      <p role="alert" className="mt-3 text-sm leading-relaxed text-slate-600">
        {ACCESS_REVOKED_MESSAGE}
      </p>
      <p className="mt-2 text-sm text-slate-600">Your notes, quizzes and progress are safe; nothing was deleted.</p>
      <Button
        className="mt-6 self-start"
        onClick={async () => {
          clearResume();
          await signOut();
          navigate("/login", { replace: true });
        }}
      >
        Sign out
      </Button>
    </main>
  );
}

/**
 * Wraps the signed-in app. It asks the API who this account is (role) and whether an administrator has paused its access.
 * A paused account sees one calm screen instead of the app - the API refuses its requests anyway. Any other failure (offline,
 * server hiccup) never locks anyone out here: the app simply carries on as a student and its own screens show their own errors.
 */
export function AccessGate() {
  const { client } = useAuth();
  const [role, setRole] = useState<Role>("student");
  const [ready, setReady] = useState(false);
  const [who, setWho] = useState<{ displayName: string; email: string | null }>({ displayName: "", email: null });
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchMe(client)
        .then((me) => {
          if (!alive) return;
          setRole(me.profile.role ?? "student");
          setWho({ displayName: me.profile.displayName, email: me.user.email });
        })
        .catch((err) => alive && err instanceof ApiError && err.status === 403 && err.body?.error === "access_revoked" && setPaused(true))
        .finally(() => alive && setReady(true));
    void load();
    const onRevoked = () => setPaused(true);
    // Coming back to the tab re-checks the role and status, so a change an admin just made (promotion, pause) shows up without signing out.
    const onFocus = () => void load();
    window.addEventListener(ACCESS_REVOKED_EVENT, onRevoked);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener(ACCESS_REVOKED_EVENT, onRevoked);
      window.removeEventListener("focus", onFocus);
    };
  }, [client]);

  if (paused) return <AccessPaused />;
  return (
    <RoleContext.Provider value={{ role, ready, ...who }}>
      <Outlet />
    </RoleContext.Provider>
  );
}
