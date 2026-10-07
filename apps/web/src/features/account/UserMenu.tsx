import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { BugIcon, ChevronUpDownIcon, KeyIcon, LogoutIcon, MoonIcon } from "../../components/ui/Icons";
import { useRoleState } from "../access/AccessGate";
import { clearResume } from "../continue/resumeStore";
import { useTheme } from "../../lib/theme";
import { BugReportDialog } from "./BugReportDialog";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

const item = "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900";

/** First letter of the name (or the email) for the round badge. */
const initial = (name: string, email: string | null): string => (name.trim() || email || "?").trim().charAt(0).toUpperCase();

/**
 * The signed-in person's menu: name, role, dark mode, change password, report a bug, sign out.
 * "sidebar" = a wide row at the bottom of the sidebar (opens upwards); "compact" = just the round badge (phones, opens downwards).
 */
export function UserMenu({ variant = "sidebar" }: { variant?: "sidebar" | "compact" | "rail" }) {
  const { signOut, user } = useAuth();
  const navigate = useNavigate();
  const { role, displayName, email } = useRoleState();
  const { resolved, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"password" | "bug" | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const name = displayName || user?.email || "Account";
  const mail = email ?? user?.email ?? null;
  const roleLabel = role === "admin" ? "Admin" : "Student";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>('[role="menu"] button')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dark = resolved === "dark";
  const badge = (
    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
      {initial(name, mail)}
    </span>
  );

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={variant !== "sidebar" ? `Account menu for ${name}` : undefined}
        onClick={() => setOpen((o) => !o)}
        className={variant !== "sidebar" ? "flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-100" : "flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-slate-100"}
      >
        {badge}
        {variant === "sidebar" && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-900">{name}</span>
              <span className="block truncate text-xs text-slate-600">{roleLabel}</span>
            </span>
            <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-slate-500" />
          </>
        )}
      </button>

      {open && (
        <div id={menuId} role="menu" aria-label="Account" className={`animate-fade-up absolute z-50 w-64 rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200 ${variant === "compact" ? "right-0 top-full mt-2" : variant === "rail" ? "bottom-0 left-full ml-3" : "bottom-full left-0 mb-2"}`}>
          <div className="border-b border-slate-100 px-3 pb-2 pt-1">
            <p className="truncate text-sm font-semibold text-slate-900">{name}</p>
            {mail && <p className="truncate text-xs text-slate-600">{mail}</p>}
            <p className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">{roleLabel}</p>
          </div>

          <button type="button" role="menuitemcheckbox" aria-checked={dark} onClick={toggle} className={`${item} mt-1 justify-between`}>
            <span className="flex items-center gap-3">
              <MoonIcon />
              Dark mode
            </span>
            <span aria-hidden="true" className={`relative h-6 w-10 rounded-full transition-colors ${dark ? "bg-brand-600" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${dark ? "left-[1.1rem]" : "left-0.5"}`} />
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog("password");
            }}
            className={item}
          >
            <KeyIcon />
            Change password
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog("bug");
            }}
            className={item}
          >
            <BugIcon />
            Report a bug
          </button>

          <div className="mt-1 border-t border-slate-100 pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                clearResume();
                await signOut();
                navigate("/login", { replace: true });
              }}
              className={`${item} text-red-700 hover:text-red-800`}
            >
              <LogoutIcon />
              Sign out
            </button>
          </div>
        </div>
      )}

      {dialog === "password" && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === "bug" && <BugReportDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
