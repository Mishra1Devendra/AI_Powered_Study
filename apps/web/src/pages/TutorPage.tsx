import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ChatPane } from "../features/tutor/ChatPane";
import { ConversationList } from "../features/tutor/ConversationList";
import { useConversationList } from "../features/tutor/useConversationList";
import { useTutorChat } from "../features/tutor/useTutorChat";
import { fetchHealth } from "../lib/tutorApi";

/** `/tutor` (new conversation) and `/tutor/:conversationId` (an existing one). */
export default function TutorPage({ basePath = "/tutor" }: { basePath?: string } = {}) {
  const { client, signOut } = useAuth();
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();
  // "Ask AI to explain" (from a quiz review) arrives with a ready-to-send message. It is only put
  // in the message box: the student reads and sends it themselves.
  const handoff = useRef(location.state as { draft?: string; subject?: string | null; topic?: string | null; documentId?: string; documentTitle?: string } | null);
  // "Ask AI about this" (from a document): questions in this chat are answered from that one document.
  const [documentScope, setDocumentScope] = useState<{ id: string; title: string } | null>(
    handoff.current?.documentId ? { id: handoff.current.documentId, title: handoff.current.documentTitle ?? "this document" } : null,
  );
  const list = useConversationList(client);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mockMode, setMockMode] = useState(false);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => setMockMode(h.ai.isMock))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const chat = useTutorChat({
    client,
    routeId: conversationId,
    documentId: documentScope?.id ?? null,
    onConversation: list.upsert,
    onCreated: (conversation) => {
      list.upsert(conversation);
      navigate(`${basePath}/${conversation.id}`, { replace: true });
    },
  });

  // Mobile history drawer: Escape closes it, focus moves in when it opens and returns on close.
  useEffect(() => {
    if (!historyOpen) return;
    drawerClose.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setHistoryOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      drawerOpener.current?.focus();
    };
  }, [historyOpen]);

  useEffect(() => {
    if (!handoff.current?.draft && !handoff.current?.documentId) return;
    const { subject, topic } = handoff.current;
    if (subject || topic) void chat.setContext({ ...(subject ? { subject } : {}), ...(topic ? { topic } : {}) });
    navigate(location.pathname, { replace: true, state: null }); // so a refresh does not paste it again
    // run once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNew = useCallback(() => navigate(basePath), [navigate, basePath]);
  const onDelete = useCallback(
    async (id: string) => {
      await list.remove(id);
      if (id === conversationId) navigate(basePath, { replace: true });
    },
    [list, conversationId, navigate, basePath],
  );
  const signInAgain = useCallback(async () => {
    await signOut();
    navigate("/login", { replace: true });
  }, [signOut, navigate]);

  const history = (onNavigate?: () => void) => (
    <ConversationList
      state={list.state}
      activeId={conversationId}
      basePath={basePath}
      onNew={onNew}
      onDelete={onDelete}
      onReload={() => void list.reload()}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside aria-label="Conversations" className="hidden w-72 shrink-0 overflow-hidden rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70 lg:block">
        {history()}
      </aside>

      <section aria-label="AI Tutor" className="min-w-0 flex-1 overflow-hidden rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70">
        <ChatPane
          conversation={chat.conversation}
          draftContext={chat.draftContext}
          messages={chat.messages}
          streamingText={chat.streamingText}
          isBusy={chat.phase === "streaming"}
          isLoading={chat.phase === "loading"}
          error={chat.error}
          loadError={chat.loadError}
          mockMode={mockMode}
          initialDraft={handoff.current?.draft ?? ""}
          documentScope={documentScope}
          onClearDocument={() => setDocumentScope(null)}
          notesBasePath={basePath.endsWith("/tutor") ? `${basePath.slice(0, -"tutor".length)}notes` : "/notes"}
          onSend={(content, mode, opts) => void chat.send(content, mode, opts)}
          onStop={chat.stop}
          onRetry={() => void chat.retry()}
          onRegenerate={() => void chat.regenerate()}
          onDismissError={chat.dismissError}
          onSetContext={(ctx) => void chat.setContext(ctx)}
          onNew={onNew}
          onReloadConversation={() => void chat.reload()}
          onSignInAgain={() => void signInAgain()}
          onOpenHistory={() => {
            drawerOpener.current = document.activeElement as HTMLElement | null;
            setHistoryOpen(true);
          }}
        />
      </section>

      {historyOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close conversation history" className="absolute inset-0 bg-slate-900/30" onClick={() => setHistoryOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label="Conversation history" className="animate-fade-up absolute inset-y-0 left-0 w-[min(20rem,85vw)] bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-base font-semibold">History</h2>
              <button ref={drawerClose} type="button" onClick={() => setHistoryOpen(false)} className="h-9 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100">
                Close
              </button>
            </div>
            <div className="h-[calc(100%-3.5rem)]">{history(() => setHistoryOpen(false))}</div>
          </div>
        </div>
      )}
    </div>
  );
}
