import { useRef, useState } from "react";
import type { ExplainResponse } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { ApiError } from "../../lib/api";
import { explainRecommendations } from "../../lib/recommendationsApi";

/**
 * The OPTIONAL AI wording. Nothing here runs by itself: the recommendations are already complete and deterministic;
 * pressing the button makes ONE call to the local AI that rewrites the top ones in friendlier words, using only the
 * same facts. If it is not available the page says so calmly and carries on.
 */
export function ExplainPanel({ onResult }: { onResult: (r: ExplainResponse | null) => void }) {
  const { client } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // State updates are not visible until the next render, so a fast double click needs a synchronous guard.
  const inFlight = useRef(false);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await explainRecommendations(client);
      setResult(r);
      onResult(r.available ? r : null);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="explain-h" className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="explain-h" className="text-base font-semibold tracking-tight text-slate-900">
            Want these in plain words?
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">Your local AI can explain the top recommendations once. It only uses the facts shown on the cards and may not be perfect.</p>
        </div>
        <Button variant="secondary" onClick={() => void run()} loading={busy} className="shrink-0">
          {result?.available ? "Explain again" : "Explain my priorities"}
        </Button>
      </div>
      {busy && (
        <div role="status" aria-live="polite" className="mt-4 flex items-start gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-900">
          <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="font-semibold">Writing the explanations…</strong>
            <span className="block text-brand-800">Your local AI is working on this. It can take a minute.</span>
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </p>
      )}
      {result && !result.available && (
        <p role="status" className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {result.message}
        </p>
      )}
      {result?.available && (
        <div className="mt-4 space-y-1.5">
          {result.overview && <p className="text-sm leading-relaxed text-slate-800">{result.overview}</p>}
          <p className="text-xs text-slate-600">
            {result.isMock ? "MOCK AI (demo) - canned text, not a real explanation." : "AI-generated, from your own facts only."} The explanations appear on the cards below.
          </p>
        </div>
      )}
    </section>
  );
}
