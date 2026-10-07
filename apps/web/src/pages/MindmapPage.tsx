import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { STUDY_TOOLS_LIMITS } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Spinner } from "../components/ui/Spinner";
import { MindmapView } from "../features/study-tools/MindmapView";
import { fieldClass } from "../features/study-tools/SourceForm";
import { useMindmap } from "../features/study-tools/useStudyTools";
import { friendlyMessage } from "../lib/errors";
import { deleteMindmap, regenerateMindmap, renameMindmap } from "../lib/studyToolsApi";

/** `/mindmaps/:id`: one map. Polls while it is being drawn so the page flips to the map on its own. */
export default function MindmapPage() {
  const { id = "" } = useParams();
  const { client } = useAuth();
  const navigate = useNavigate();
  const map = useMindmap(client, id);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (map.state.status === "loading") return <LoadingState label="Loading the mind map…" />;
  if (map.state.status === "error") {
    const gone = /not found/i.test(map.state.message);
    return (
      <div className="space-y-4">
        <ErrorState message={gone ? "That mind map doesn't exist any more." : map.state.message} {...(gone ? {} : { onRetry: () => void map.reload() })} />
        <Link to="/mindmaps" className="inline-block text-sm font-medium text-brand-700 underline">
          Back to your mind maps
        </Link>
      </div>
    );
  }
  const m = map.state.data;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await renameMindmap(client, m.id, title.trim());
      setRenaming(false);
      await map.refresh();
    } catch (err) {
      setNotice(friendlyMessage(err, "Could not rename the map."));
    }
  }

  async function again() {
    setBusy(true);
    setNotice(null);
    try {
      navigate(`/mindmaps/${(await regenerateMindmap(client, m.id)).id}`);
    } catch (err) {
      setNotice(friendlyMessage(err, "Could not start a new map. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await deleteMindmap(client, m.id);
      navigate("/mindmaps");
    } catch (err) {
      setNotice(friendlyMessage(err, "Could not delete the map."));
    }
  }

  return (
    <div className="animate-fade-up mx-auto max-w-6xl">
      <Link to="/mindmaps" className="-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> All mind maps
      </Link>

      <header className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {renaming ? (
            <form onSubmit={(e) => void saveName(e)} className="flex flex-wrap gap-2">
              <input aria-label="Mind map name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.titleMaxChars} className={`${fieldClass} sm:w-80`} />
              <Button type="submit" className="h-11">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            </form>
          ) : (
            <h1 className="break-words text-2xl font-semibold tracking-tight">{m.title}</h1>
          )}
          <p className="mt-1 text-sm text-slate-600">
            {m.status === "ready" ? `${m.nodeCount} ideas · ${m.sourceType === "notes" ? "from your notes" : "from a subject"}` : m.status === "generating" ? "Being drawn…" : "Could not be drawn"}
            {m.isMock && m.status === "ready" && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">Demo AI: placeholder map</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!renaming && (
            <Button variant="secondary" onClick={() => (setTitle(m.title), setRenaming(true))}>
              Rename
            </Button>
          )}
          {m.status !== "generating" && (
            <Button variant="secondary" loading={busy} onClick={() => void again()}>
              Draw again
            </Button>
          )}
          <Button variant="secondary" className="text-red-700" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </header>

      {notice && (
        <div className="mt-4">
          <Alert tone="error">{notice}</Alert>
        </div>
      )}
      {confirmDelete && (
        <div role="alertdialog" aria-label="Delete this mind map?" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 ring-1 ring-red-200">
          <p className="text-sm text-red-900">Delete this mind map? This can&apos;t be undone.</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="h-10" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button className="h-10 bg-red-600 hover:bg-red-700" onClick={() => void remove()}>
              Delete map
            </Button>
          </div>
        </div>
      )}

      <div className="mt-6">
        {m.status === "generating" && (
          <Card>
            <p className="flex items-center gap-3 text-sm text-slate-700" role="status">
              <Spinner /> Drawing your map. This usually takes under a minute; you can leave this page and come back.
            </p>
          </Card>
        )}
        {m.status === "error" && <ErrorState message={m.error ?? "The mind map could not be drawn."} />}
        {m.status === "ready" && m.tree && <MindmapView tree={m.tree} title={m.title} />}
      </div>
    </div>
  );
}
