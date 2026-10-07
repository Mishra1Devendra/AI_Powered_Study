import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { SEARCH_LIMITS, type SearchResponse } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { NAV_ITEMS } from "../../components/layout/nav";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton, SkeletonRegion } from "../../components/ui/Skeleton";
import { OFFLINE_MESSAGE, friendlyMessage } from "../../lib/errors";
import { searchEverything } from "../../lib/experienceApi";
import { useOnlineStatus } from "../../lib/useOnlineStatus";

const DEBOUNCE_MS = 250;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href]';

interface Item {
  key: string;
  group: string;
  title: string;
  detail: string | null;
  to: string;
  state?: unknown;
}

/** Pages are matched on the device: no request, instant. */
const PAGES: Array<{ title: string; detail: string; to: string }> = [
  ...NAV_ITEMS.map((n) => ({ title: n.label, detail: "Go to page", to: n.to })),
  { title: "Create a quiz", detail: "Quiz", to: "/quiz/new" },
  { title: "Upload notes", detail: "My Notes", to: "/notes" },
  { title: "New study plan", detail: "Study Plan", to: "/study-plan/new" },
];

const GROUPS: Array<{ key: keyof Pick<SearchResponse, "documents" | "quizzes" | "plans" | "conversations">; label: string }> = [
  { key: "documents", label: "Notes & documents" },
  { key: "quizzes", label: "Quizzes" },
  { key: "plans", label: "Study plans" },
  { key: "conversations", label: "Tutor conversations" },
];

function toItems(query: string, data: SearchResponse | null): Item[] {
  const needle = query.trim().toLowerCase();
  const pages: Item[] = PAGES.filter((p) => needle === "" || p.title.toLowerCase().includes(needle))
    .slice(0, needle === "" ? 12 : 4)
    .map((p) => ({ key: `page:${p.to}:${p.title}`, group: "Pages", title: p.title, detail: p.detail, to: p.to }));
  if (!data) return pages;
  const found: Item[] = GROUPS.flatMap((g) => data[g.key].map((h): Item => ({ key: `${g.key}:${h.id}`, group: g.label, title: h.title, detail: h.detail, to: h.href })));
  const topics: Item[] = data.topics.slice(0, SEARCH_LIMITS.perGroup).map((t, i) => {
    const label = [t.subject, t.topic].filter(Boolean).join(" · ");
    return {
      key: `topic:${i}:${label}`,
      group: "Subjects & topics",
      title: label,
      detail: "Open the AI Tutor with this ready (nothing is sent)",
      to: "/tutor",
      // The tutor receives a suggested question; it is only put in the message box.
      state: { draft: `Help me study ${t.topic ?? t.subject ?? "this"}.`, ...(t.subject ? { subject: t.subject } : {}), ...(t.topic ? { topic: t.topic } : {}) },
    };
  });
  return [...found, ...topics, ...pages];
}

type Load = { status: "idle" } | { status: "loading" } | { status: "ready"; data: SearchResponse } | { status: "error"; message: string };

/**
 * Global search / quick navigation. Keyboard first (type, Up/Down, Enter, Esc) and a full-screen sheet on phones.
 * It searches the student's OWN notes, quizzes, study plans, tutor chats, subjects and topics by title - it is navigation,
 * not question answering, and no AI model is involved.
 */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client } = useAuth();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [query, setQuery] = useState("");
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const listId = useId();

  const trimmed = query.trim();
  const searchable = trimmed.length >= SEARCH_LIMITS.minChars;

  // Remember who opened it (to return focus), start fresh each time.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setQuery("");
    setLoad({ status: "idle" });
    setActive(0);
    queueMicrotask(() => inputRef.current?.focus());
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, [open]);

  // Debounced search; a newer keystroke cancels the older request.
  useEffect(() => {
    if (!open || !searchable || !online) {
      setLoad({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setLoad({ status: "loading" });
    const timer = setTimeout(() => {
      searchEverything(client, trimmed, controller.signal)
        .then((data) => !controller.signal.aborted && setLoad({ status: "ready", data }))
        .catch((err: unknown) => !controller.signal.aborted && setLoad({ status: "error", message: friendlyMessage(err, "We couldn't search right now. Please try again.") }));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchable, trimmed, client, online, retry]);

  const items = useMemo(() => toItems(trimmed, load.status === "ready" ? load.data : null), [trimmed, load]);
  useEffect(() => setActive(0), [items.length, trimmed]);

  const go = useCallback(
    (item: Item) => {
      onClose();
      navigate(item.to, item.state !== undefined ? { state: item.state } : undefined);
    },
    [navigate, onClose],
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (items.length === 0 ? 0 : (a + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (items.length === 0 ? 0 : (a - 1 + items.length) % items.length));
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      const item = items[active];
      if (item) {
        e.preventDefault();
        go(item);
      }
    } else if (e.key === "Tab") {
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  }

  if (!open) return null;

  const grouped = items.reduce<Array<{ label: string; entries: Array<{ item: Item; index: number }> }>>((acc, item, index) => {
    const last = acc[acc.length - 1];
    if (last && last.label === item.group) last.entries.push({ item, index });
    else acc.push({ label: item.group, entries: [{ item, index }] });
    return acc;
  }, []);
  const hasRealResults = load.status === "ready" && items.some((i) => i.group !== "Pages");
  const activeId = items[active] ? `${listId}-opt-${active}` : undefined;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/50 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        className="mx-auto flex h-full w-full flex-col bg-white shadow-2xl sm:mt-[8vh] sm:h-auto sm:max-h-[78vh] sm:max-w-xl sm:rounded-2xl"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search your notes, quizzes, plans and topics"
            value={query}
            maxLength={SEARCH_LIMITS.maxChars}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your study material"
            autoComplete="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-slate-900 placeholder:text-slate-500 focus:outline-none"
          />
          <button type="button" onClick={onClose} className="h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100">
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {!online && searchable && <p role="status" className="mx-2 my-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{OFFLINE_MESSAGE}</p>}
          {query !== "" && !searchable && <p className="px-3 py-2 text-sm text-slate-600">Type at least {SEARCH_LIMITS.minChars} characters to search your notes, quizzes, plans and topics.</p>}

          {load.status === "loading" && (
            <SkeletonRegion label="Searching your study material" className="space-y-2 px-3 py-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-5/6" />
            </SkeletonRegion>
          )}
          {load.status === "error" && (
            <div className="p-2">
              <ErrorState compact message={load.message} onRetry={() => setRetry((n) => n + 1)} />
            </div>
          )}
          {load.status === "ready" && !hasRealResults && (
            <p role="status" className="px-3 py-3 text-sm text-slate-700">
              No results for &ldquo;{trimmed}&rdquo; in your notes, quizzes, plans or topics. Check the spelling or try a shorter word.
            </p>
          )}

          <ul id={listId} role="listbox" aria-label="Search results">
            {grouped.map((g) => (
              <li key={g.label} role="presentation" className="mb-1">
                <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-600">{g.label}</p>
                <ul role="group" aria-label={g.label}>
                  {g.entries.map(({ item, index }) => (
                    <li
                      key={item.key}
                      id={`${listId}-opt-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseMove={() => setActive(index)}
                      onClick={() => go(item)}
                      className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-lg px-3 py-2 ${index === active ? "bg-brand-50" : "hover:bg-slate-50"}`}
                    >
                      <span className="break-words text-sm font-medium text-slate-900">{item.title}</span>
                      {item.detail && <span className="break-words text-xs text-slate-600">{item.detail}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden border-t border-slate-100 px-4 py-2 text-xs text-slate-600 sm:block">
          <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-sans">↑</kbd> <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-sans">↓</kbd> to move · <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-sans">Enter</kbd> to open · <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-sans">Esc</kbd> to close
        </p>
      </div>
    </div>,
    document.body,
  );
}
