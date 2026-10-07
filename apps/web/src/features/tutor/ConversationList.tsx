import { useState } from "react";
import { NavLink } from "react-router";
import type { Conversation } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../dashboard/format";

interface ConversationListProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; conversations: Conversation[] };
  activeId: string | undefined;
  /** Route prefix the conversation links point at ("/tutor"; the dev preview uses its own). */
  basePath?: string;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
  onReload: () => void;
  /** Called after navigating (lets the mobile drawer close). */
  onNavigate?: () => void;
}

export function ConversationList({ state, activeId, basePath = "/tutor", onNew, onDelete, onReload, onNavigate }: ConversationListProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const now = new Date();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Button
          onClick={() => {
            onNew();
            onNavigate?.();
          }}
          className="w-full"
        >
          New conversation
        </Button>
      </div>
      <nav aria-label="Conversation history" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {state.status === "loading" && (
          <div aria-busy="true" role="status" className="space-y-2 px-1">
            <span className="sr-only">Loading conversations</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        )}
        {state.status === "error" && (
          <div role="alert" className="space-y-2 px-2 text-sm text-slate-700">
            <p>{state.message}</p>
            <Button variant="secondary" onClick={onReload} className="h-9">
              Try again
            </Button>
          </div>
        )}
        {state.status === "ready" && state.conversations.length === 0 && (
          <p className="px-3 py-4 text-sm text-slate-600">No conversations yet. Ask your first question to get started.</p>
        )}
        {deleteError && (
          <p role="alert" className="px-3 pb-2 text-sm text-red-700">
            {deleteError}
          </p>
        )}
        {state.status === "ready" && (
          <ul className="space-y-0.5">
            {state.conversations.map((c) => {
              const detail = [c.subject, c.topic].filter(Boolean).join(" · ");
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  {confirming === c.id ? (
                    <div className="rounded-xl bg-red-50 p-3 text-sm text-red-900">
                      <p className="font-medium">Delete this conversation?</p>
                      <p className="mt-0.5 text-xs">It will be removed from your history.</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          className="h-8 rounded-lg bg-red-700 px-3 text-sm font-medium text-white hover:bg-red-800"
                          onClick={async () => {
                            setDeleteError(null);
                            try {
                              await onDelete(c.id);
                            } catch {
                              setDeleteError("Could not delete that conversation. Please try again.");
                            }
                            setConfirming(null);
                          }}
                        >
                          Delete
                        </button>
                        <button type="button" className="h-8 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-white" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={`group relative flex items-center rounded-xl transition-colors ${active ? "bg-brand-50 before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-brand-600" : "hover:bg-slate-50"}`}>
                      <NavLink
                        to={`${basePath}/${c.id}`}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className="min-w-0 flex-1 rounded-xl px-3 py-2.5"
                      >
                        <span className={`block truncate text-sm font-medium ${active ? "text-brand-700" : "text-slate-900"}`}>{c.title}</span>
                        <span className="block truncate text-xs text-slate-600">
                          {detail ? `${detail} · ` : ""}
                          {relativeTime(c.updatedAt, now)}
                        </span>
                      </NavLink>
                      <button
                        type="button"
                        aria-label={`Delete conversation: ${c.title}`}
                        onClick={() => setConfirming(c.id)}
                        className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-red-700 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
