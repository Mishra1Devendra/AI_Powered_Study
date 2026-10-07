import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { SourceRef } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { AssistantPane } from "../features/notes/AssistantPane";
import { Provenance } from "../features/notes/AssistantMessage";
import { AskAiLink, QuizFromNoteLink, StudyToolLinks } from "../features/notes/AskAiLink";
import { DocumentPane, chunkDomId } from "../features/notes/DocumentPane";
import { IndexChecklist } from "../features/notes/IndexChecklist";
import { InfoPane } from "../features/notes/InfoPane";
import { IndeterminateBar, StatusBadge } from "../features/notes/StatusBadge";
import { useNoteDocument } from "../features/notes/useNoteDocument";
import { useNotesAssistant } from "../features/notes/useNotesAssistant";
import { fetchHealth } from "../lib/tutorApi";

type Tab = "document" | "assistant" | "info";
const TABS: { id: Tab; label: string }[] = [
  { id: "document", label: "Document" },
  { id: "assistant", label: "Assistant" },
  { id: "info", label: "Outline" },
];

const panel = "min-h-0 flex-col overflow-hidden rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70";

/** `/notes/:noteId`: info + outline | the document | the AI study assistant. One column with tabs on small screens. */
export default function NoteWorkspacePage({ basePath = "/notes" }: { basePath?: string } = {}) {
  const { noteId = "" } = useParams<{ noteId: string }>();
  const { client, signOut } = useAuth();
  const navigate = useNavigate();
  const document_ = useNoteDocument(client, noteId);
  const ready = document_.doc.status === "ready" && document_.doc.note.status === "ready";
  const assistant = useNotesAssistant(client, noteId, ready);
  const [tab, setTab] = useState<Tab>("document");
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const [ai, setAi] = useState<{ isMock: boolean; model: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => setAi({ isMock: h.ai.isMock, model: h.ai.model }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const { ensureLoaded } = document_;
  const goTo = useCallback(
    async (chunkIndex: number) => {
      setTab("document");
      await ensureLoaded(chunkIndex);
      setJump((j) => ({ index: chunkIndex, nonce: (j?.nonce ?? 0) + 1 }));
    },
    [ensureLoaded],
  );
  const onSource = useCallback((s: SourceRef) => void goTo(s.chunkIndex), [goTo]);

  // Scroll to the cited passage once it is rendered; the highlight fades after a few seconds.
  useEffect(() => {
    if (!jump) return;
    const frame = requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.document.getElementById(chunkDomId(jump.index))?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
    });
    const timer = setTimeout(() => setJump(null), 4000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [jump]);

  const signInAgain = useCallback(async () => {
    await signOut();
    navigate("/login", { replace: true });
  }, [signOut, navigate]);

  const { doc } = document_;
  const back = (
    <Link to={basePath} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
      <span aria-hidden="true">←</span> All notes
    </Link>
  );

  if (doc.status === "loading") {
    return (
      <div role="status" aria-busy="true" className="space-y-4 p-2">
        <span className="sr-only">Loading note</span>
        {back}
        <div className="h-8 w-1/3 animate-pulse rounded-lg bg-slate-100" />
        <div className="h-64 animate-pulse rounded-2xl bg-slate-100" />
      </div>
    );
  }
  if (doc.status === "error") {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-2">
        {back}
        <Alert tone="error">{doc.message}</Alert>
        {!doc.notFound && (
          <Button variant="secondary" onClick={() => void document_.reloadDoc()}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  const { note, outline } = doc;
  if (note.status !== "ready") {
    const busy = note.status === "uploading" || note.status === "processing";
    return (
      <div className="mx-auto max-w-lg space-y-4 p-2">
        {back}
        <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="min-w-0 break-words text-lg font-semibold tracking-tight">{note.title}</h1>
            <StatusBadge status={note.status} />
          </div>
          {busy ? (
            <div role="status" className="mt-4">
              <IndeterminateBar label="Processing" />
              <p className="mt-2 text-sm text-slate-600">We’re reading and organising this material. It will open here automatically when it’s ready.</p>
              <div className="mt-3">
                <IndexChecklist note={note} />
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium text-slate-800">We couldn’t prepare this document.</p>
              <Alert tone="error">{note.error ?? "We couldn’t process this file."}</Alert>
              <Button onClick={() => void document_.retry()}>Retry processing</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const show = (id: Tab) => (tab === id ? "flex" : "hidden");
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {back}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-slate-900">{note.title}</h1>
        <StatusBadge status={note.status} />
        <AskAiLink note={note} basePath={basePath} />
        <QuizFromNoteLink note={note} basePath={basePath} />
        {note.status === "ready" && <StudyToolLinks note={note} basePath={basePath} />}
        {ai && <Provenance isMock={ai.isMock} model={ai.model} />}
      </header>

      <div role="group" aria-label="Workspace sections" className="flex gap-1 rounded-xl bg-slate-100 p-1 lg:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`h-10 flex-1 rounded-lg text-sm font-medium transition ${tab === t.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_22rem] xl:grid-cols-[17rem_minmax(0,1fr)_26rem]">
        <section aria-label="Document info and outline" className={`${panel} ${show("info")} lg:flex`}>
          <InfoPane note={note} outline={outline} activeChunk={jump?.index ?? null} onJump={(i) => void goTo(i)} basePath={basePath} />
        </section>
        <section aria-label="Document" className={`${panel} ${show("document")} lg:flex`}>
          <DocumentPane
            fileType={note.fileType}
            chunks={document_.chunks}
            first={document_.first}
            total={document_.total}
            hasMore={document_.hasMore}
            loading={document_.contentLoading}
            error={document_.contentError}
            highlight={jump?.index ?? null}
            onLoadMore={document_.loadMore}
            onLoadEarlier={document_.loadEarlier}
            onRetry={() => void document_.retryContent()}
          />
        </section>
        <section aria-label="AI study assistant" className={`${panel} ${show("assistant")} lg:flex`}>
          <AssistantPane assistant={assistant} title={note.title} onSource={onSource} onSignInAgain={() => void signInAgain()} />
        </section>
      </div>
    </div>
  );
}
