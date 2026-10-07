import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AI_COST, MINDMAP_SIZE_TARGET, type Mindmap, type MindmapSize } from "@copilot/shared";
import { AiUsageNote } from "../features/ai-usage/AiUsageNote";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { EmblemBadge } from "../components/ui/EmblemBadge";
import { MindmapIcon, SparkIcon } from "../components/ui/Icons";
import { Spinner } from "../components/ui/Spinner";
import { SourceForm } from "../features/study-tools/SourceForm";
import { useMindmaps } from "../features/study-tools/useStudyTools";
import { useQuizOptions } from "../features/quiz/useQuizData";
import { friendlyMessage } from "../lib/errors";
import { generateMindmap } from "../lib/studyToolsApi";

const SIZES: Array<{ value: MindmapSize; label: string; hint: string }> = [
  { value: "small", label: "Small", hint: `about ${MINDMAP_SIZE_TARGET.small.nodes} ideas` },
  { value: "medium", label: "Medium", hint: `about ${MINDMAP_SIZE_TARGET.medium.nodes} ideas` },
  { value: "large", label: "Large", hint: `about ${MINDMAP_SIZE_TARGET.large.nodes} ideas` },
];

function MapTile({ map }: { map: Mindmap }) {
  return (
    <li className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 transition hover:ring-brand-200">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/mindmaps/${map.id}`} className="-my-1.5 min-w-0 py-1.5 text-base font-semibold text-slate-900 hover:text-brand-700">
          <span className="line-clamp-2 break-words">{map.title}</span>
        </Link>
        {map.isMock && map.status === "ready" && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">Demo AI</span>}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {map.sourceType === "notes" ? "From your notes" : "From a subject"} · {new Date(map.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
      </p>
      <div className="mt-4 text-sm">
        {map.status === "generating" && (
          <p className="flex items-center gap-2 text-slate-600" role="status">
            <Spinner className="h-4 w-4" /> Drawing your map…
          </p>
        )}
        {map.status === "error" && <p className="text-red-700">{map.error}</p>}
        {map.status === "ready" && <p className="text-slate-600">{map.nodeCount} ideas</p>}
      </div>
      <Link to={`/mindmaps/${map.id}`} className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-xl bg-white px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
        {map.status === "ready" ? "Open map" : "View"}
      </Link>
    </li>
  );
}

/** `/mindmaps`: your maps and the way to draw a new one from your notes or a subject. */
export default function MindmapsPage() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const maps = useMindmaps(client);
  const options = useQuizOptions(client);
  const fromNote = params.get("document")?.slice(0, 64) ?? undefined;
  const [open, setOpen] = useState(Boolean(fromNote));
  const [size, setSize] = useState<MindmapSize>("medium");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="animate-fade-up">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mind maps</h1>
          <p className="mt-1 text-sm text-slate-600">See how the ideas in a topic connect, on one page.</p>
        </div>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <SparkIcon className="h-4 w-4" /> {open ? "Close" : "New mind map"}
        </Button>
      </header>

      {open && (
        <Card className="mt-6">
          <AiUsageNote cost={AI_COST.mindmap} className="mb-5" />
          {options.state.status === "loading" && <LoadingState label="Loading your notes…" shape="form" />}
          {options.state.status === "error" && <ErrorState message={options.state.message} onRetry={() => void options.reload()} />}
          {options.state.status === "ready" && (
            <SourceForm
              options={options.state.data}
              prefillDocumentId={fromNote}
              submitLabel="Draw my map"
              error={error}
              extra={
                <fieldset>
                  <legend className="text-sm font-medium text-slate-800">How detailed?</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {SIZES.map((s) => (
                      <button key={s.value} type="button" aria-pressed={size === s.value} onClick={() => setSize(s.value)} className={`rounded-xl px-4 py-2.5 text-left ring-1 transition ${size === s.value ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-slate-300 hover:bg-slate-50"}`}>
                        <span className={`block text-sm font-medium ${size === s.value ? "text-brand-700" : "text-slate-800"}`}>{s.label}</span>
                        <span className="block text-xs text-slate-600">{s.hint}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              }
              onSubmit={async (source, title) => {
                setError(null);
                try {
                  const map = await generateMindmap(client, { source, size, ...(title ? { title } : {}) });
                  navigate(`/mindmaps/${map.id}`);
                } catch (err) {
                  setError(friendlyMessage(err, "Could not start drawing the map. Please try again."));
                }
              }}
            />
          )}
        </Card>
      )}

      {maps.state.status === "loading" && <LoadingState label="Loading your mind maps…" />}
      {maps.state.status === "error" && (
        <div className="mt-6">
          <ErrorState message={maps.state.message} onRetry={() => void maps.reload()} />
        </div>
      )}
      {maps.state.status === "ready" &&
        (maps.state.data.length === 0 ? (
          <div className="mt-6 rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70">
            <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-14 text-center">
              <EmblemBadge>
                <MindmapIcon className="h-7 w-7" />
              </EmblemBadge>
              <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-slate-900">Turn a chapter into a map.</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">Pick a note or a subject and get the main ideas and how they branch. Fold branches to focus, or download the image for revision.</p>
              <Button className="mt-6" onClick={() => setOpen(true)}>
                <SparkIcon className="h-4 w-4" /> Draw my first map
              </Button>
            </div>
          </div>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your mind maps">
            {maps.state.data.map((m) => (
              <MapTile key={m.id} map={m} />
            ))}
          </ul>
        ))}
    </div>
  );
}
