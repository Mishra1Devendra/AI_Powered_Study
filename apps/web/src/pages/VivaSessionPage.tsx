import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { VivaDetail } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { DifficultyBadge, ProvenanceBadge, StatusBadge } from "../features/viva/Badges";
import { QuestionReview } from "../features/viva/Evaluation";
import { title } from "../features/viva/format";
import { useVivaPaths } from "../features/viva/paths";
import { ResultView } from "../features/viva/ResultView";
import { SessionView } from "../features/viva/SessionView";
import { useVivaDetail } from "../features/viva/useViva";
import { createViva } from "../lib/vivaApi";

function Abandoned({ detail }: { detail: VivaDetail }) {
  const { client } = useAuth();
  const p = useVivaPaths();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session, questions } = detail;
  async function again() {
    setBusy(true);
    setError(null);
    try {
      const d = await createViva(client, { subject: session.subject, ...(session.topic ? { topic: session.topic } : {}), difficulty: session.difficulty, questionCount: session.questionCount, ...(session.sourceType && session.sourceType !== "general" ? { sourceType: session.sourceType } : {}), ...(session.sourceType === "document" && session.documentId ? { documentId: session.documentId } : {}) });
      navigate(p.session(d.session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> All vivas
      </Link>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="abandoned" />
          <ProvenanceBadge isMock={session.isMock} model={session.model} />
          <DifficultyBadge d={session.difficulty} />
        </div>
        <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight text-slate-900">{title(session)}</h1>
        <p className="mt-1 text-sm text-slate-600">This viva was ended after {session.answeredCount} of {session.questionCount} answers, so it has no score.</p>
        <div className="mt-4">
          <Button onClick={() => void again()} loading={busy}>
            Practice Again
          </Button>
        </div>
        {error && (
          <div className="mt-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </Card>
      {questions.some((q) => q.answer) && (
        <ol className="space-y-4">
          {questions.filter((q) => q.answer).map((q) => (
            <QuestionReview key={q.id} q={q} subject={session.subject} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** `/viva/:id`: the viva as it is now - in progress, completed (results and review) or ended. */
export default function VivaSessionPage() {
  const { id = "" } = useParams<{ id: string }>();
  const p = useVivaPaths();
  const { client } = useAuth();
  const loaded = useVivaDetail(client, id);
  // The latest detail returned by an action (answer / next); replaces the loaded one without another request.
  const [live, setLive] = useState<{ id: string; detail: VivaDetail } | null>(null);
  const detail = live?.id === id ? live.detail : loaded.state.status === "ready" ? loaded.state.data : null;

  if (!detail) {
    return (
      <div className="mx-auto max-w-xl py-10">
        {loaded.state.status === "error" ? (
          <div className="space-y-3">
            <Alert tone="error">{loaded.notFound ? "This viva doesn't exist, or it isn't yours." : loaded.state.message}</Alert>
            <div className="flex gap-2">
              {!loaded.notFound && (
                <Button variant="secondary" onClick={() => void loaded.reload()}>
                  Try again
                </Button>
              )}
              <Link to={p.home} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
                All vivas
              </Link>
            </div>
          </div>
        ) : (
          <LoadingState label="Loading your viva…" />
        )}
      </div>
    );
  }

  const update = (d: VivaDetail) => setLive({ id, detail: d });
  return (
    <div className="animate-fade-up">
      {/* A new question remounts the view, so nothing typed for the previous question can carry over. */}
      {detail.session.status === "completed" ? <ResultView detail={detail} /> : detail.session.status === "abandoned" ? <Abandoned detail={detail} /> : <SessionView key={`${detail.session.id}:${detail.questions[detail.questions.length - 1]!.id}`} detail={detail} onUpdate={update} />}
    </div>
  );
}
