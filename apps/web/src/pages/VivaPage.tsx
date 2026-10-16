import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { CreateVivaRequest } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Card } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { ContinueBar } from "../features/continue/ContinueBar";
import { ProvenanceBadge } from "../features/viva/Badges";
import { HistoryList } from "../features/viva/HistoryList";
import { useVivaPaths } from "../features/viva/paths";
import { SetupForm } from "../features/viva/SetupForm";
import { useVivaList, useVivaOptions } from "../features/viva/useViva";
import { ApiError } from "../lib/api";
import { createViva } from "../lib/vivaApi";
import { fetchHealth } from "../lib/tutorApi";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";

/** `/viva`: practice explaining a topic to an AI examiner. Setup first, then your earlier vivas. */
export default function VivaPage() {
  const p = useVivaPaths();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // From a recommendation: only text for the form, length-limited. Nothing starts until Start Viva is pressed.
  const initial = { subject: params.get("subject")?.slice(0, 100) ?? "", topic: params.get("topic")?.slice(0, 100) ?? "" };
  const list = useVivaList(client);
  const options = useVivaOptions(client);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [ai, setAi] = useState<{ isMock: boolean; model: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => setAi({ isMock: h.ai.isMock, model: h.ai.model }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function onStart(input: CreateViva) {
    setError(null);
    setPreparing(true);
    try {
      const d = await createViva(client, input);
      navigate(p.session(d.session.id));
    } catch (e) {
      setPreparing(false);
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  return (
    <div className="animate-fade-up space-y-6">
      <header className="palette-light hero-surface rounded-(--radius-card) p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#e8c25c]">AI Viva</p>
        <h1 className="mt-2 max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">Practice explaining concepts like you&apos;re answering a real examiner.</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/80">
          An AI examiner asks you questions, you answer in writing, and it tells you what was right and what was missing. It may ask a follow-up when your answer needs one.
        </p>
        {ai && (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-white/80">
            Examiner: <ProvenanceBadge isMock={ai.isMock} model={ai.model} />
          </p>
        )}
        <p className="mt-4 max-w-xl text-xs leading-relaxed text-white/75">
          When enabled, your viva topic and answers may be sent to Google Gemini. Google's unpaid-tier terms say submitted content may be used to improve products and may be reviewed by humans. AI is currently unavailable while model free-tier eligibility is unverified.
        </p>
      </header>

      <div className="empty:hidden">
        <ContinueBar hideFor="/viva" />
      </div>

      <Card>
        <h2 className="mb-4 text-lg font-semibold tracking-tight text-slate-900">Start a viva</h2>
        {preparing && (
          <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl bg-brand-50 px-4 py-4 text-sm text-brand-900">
            <Spinner className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              <strong className="block text-base font-semibold">Preparing your Viva…</strong>
              The examiner is preparing your first question. This can take a little while.
            </span>
          </div>
        )}
        {/* The form stays mounted (just hidden) while the examiner works, so a failure leaves everything the student typed. */}
        {options.state.status === "error" ? (
          <ErrorState message={options.state.message} onRetry={() => void options.reload()} />
        ) : (
          <div hidden={preparing}>
            <SetupForm key={`${initial.subject}|${initial.topic}`} options={options.state.status === "ready" ? options.state.data : null} onStart={onStart} error={error} initial={initial} />
          </div>
        )}
      </Card>

      {list.state.status === "loading" && (
        <LoadingState label="Loading your vivas…" />
      )}
      {list.state.status === "error" && (
        <ErrorState message={list.state.message} onRetry={() => void list.reload()} />
      )}
      {list.state.status === "ready" && <HistoryList data={list.state.data} />}
    </div>
  );
}

type CreateViva = CreateVivaRequest;
