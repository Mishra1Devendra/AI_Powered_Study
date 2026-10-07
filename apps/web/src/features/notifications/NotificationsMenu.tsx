import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { AppNotification, NotificationKind } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorState } from "../../components/ui/ErrorState";
import { SkeletonList, SkeletonRegion } from "../../components/ui/Skeleton";
import { OFFLINE_MESSAGE, friendlyMessage } from "../../lib/errors";
import { getNotifications } from "../../lib/experienceApi";
import { useOnlineStatus } from "../../lib/useOnlineStatus";

const KIND_LABEL: Record<NotificationKind, string> = {
  session_missed: "Study plan",
  session_today: "Study plan",
  quiz_result: "Quiz",
  viva_result: "Viva",
  recommendation: "Recommendation",
};
const TONE_TEXT = { attention: "Needs attention", info: "For today", success: "Result" } as const;
const TONE_DOT = { attention: "bg-amber-500", info: "bg-brand-500", success: "bg-emerald-500" } as const;
const REFRESH_AFTER_MS = 60_000;
const MAX_REMEMBERED = 200;

const storageKey = (userId: string) => `copilot.notifications.read.${userId}`;
function readSet(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set(); // storage can be blocked (private window): everything simply shows as unread
  }
}
function writeSet(userId: string, ids: Set<string>) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify([...ids].slice(-MAX_REMEMBERED)));
  } catch {
    /* ignore: "read" is a convenience, not data */
  }
}

type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; items: AppNotification[]; partial: boolean } | { status: "error"; message: string };

/**
 * The in-app notification centre. What it shows is worked out on request from the student's own records (study plan,
 * quiz and viva results, the top recommendation) - nothing is stored, scheduled or pushed, and no AI is involved.
 * "Read" is remembered only in this browser.
 */
export function NotificationsMenu() {
  const { client, user } = useAuth();
  const userId = user?.id ?? "";
  const online = useOnlineStatus();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [readIds, setReadIds] = useState<Set<string>>(() => readSet(userId));
  const loadedAt = useRef(0);
  const inFlight = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const refresh = useCallback(
    async (force: boolean) => {
      if (inFlight.current || (!force && Date.now() - loadedAt.current < REFRESH_AFTER_MS)) return;
      inFlight.current = true;
      setLoad((l) => (l.status === "ready" ? l : { status: "loading" }));
      try {
        const res = await getNotifications(client);
        loadedAt.current = Date.now();
        setLoad({ status: "ready", items: res.notifications, partial: res.partial });
      } catch (err) {
        setLoad((l) => (l.status === "ready" ? l : { status: "error", message: friendlyMessage(err, "We couldn't load your notifications. Please try again.") }));
      } finally {
        inFlight.current = false;
      }
    },
    [client],
  );

  // The dashboard is where the student lands, so the bell is ready (and shows what is new) when they get there.
  useEffect(() => {
    if (userId && online && pathname === "/dashboard") void refresh(false);
  }, [userId, online, pathname, refresh]);

  useEffect(() => setReadIds(readSet(userId)), [userId]);
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    if (online) void refresh(false);
    (panelRef.current?.querySelector<HTMLElement>("a, button") ?? panelRef.current)?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, online, refresh]);

  const items = load.status === "ready" ? load.items : [];
  const unread = items.filter((n) => !readIds.has(n.id));

  function mark(ids: string[]) {
    const next = new Set([...readIds, ...ids]);
    setReadIds(next);
    writeSet(userId, next);
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={unread.length > 0 ? `Notifications, ${unread.length} unread` : "Notifications"}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9zM10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread.length > 0 && (
          <span aria-hidden="true" className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="animate-fade-up fixed inset-x-3 top-16 z-50 max-h-[75vh] overflow-y-auto rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200 sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-900">Notifications</h2>
            {unread.length > 0 && (
              <button type="button" onClick={() => mark(items.map((n) => n.id))} className="rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50">
                Mark all as read
              </button>
            )}
          </div>
          {!online && <p role="status" className="mx-2 mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{OFFLINE_MESSAGE}</p>}
          {load.status === "loading" && (
            <SkeletonRegion label="Loading your notifications" className="px-3">
              <SkeletonList rows={3} />
            </SkeletonRegion>
          )}
          {load.status === "error" && (
            <div className="p-2">
              <ErrorState compact message={load.message} onRetry={() => void refresh(true)} />
            </div>
          )}
          {load.status === "ready" && items.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-slate-900">You&apos;re all caught up.</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-slate-600">Study sessions that need you, new quiz and viva results and your top recommendation show up here.</p>
            </div>
          )}
          {load.status === "ready" && load.partial && items.length > 0 && <p className="mx-3 mb-1 text-xs text-slate-600">Some updates couldn&apos;t be loaded just now.</p>}
          {items.length > 0 && (
            <ul>
              {items.map((n) => {
                const isUnread = !readIds.has(n.id);
                return (
                  <li key={n.id}>
                    <Link to={n.href} onClick={() => mark([n.id])} className="flex gap-3 rounded-xl px-3 py-3 transition hover:bg-slate-50">
                      <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${isUnread ? TONE_DOT[n.tone] : "bg-slate-200"}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                          <span className="font-semibold">{KIND_LABEL[n.kind]}</span>
                          <span>{TONE_TEXT[n.tone]}</span>
                          {isUnread && <span className="font-semibold text-brand-700">New</span>}
                        </span>
                        <span className={`mt-0.5 block break-words text-sm ${isUnread ? "font-semibold text-slate-900" : "font-medium text-slate-700"}`}>{n.title}</span>
                        {n.body && <span className="mt-0.5 block break-words text-sm text-slate-600">{n.body}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
