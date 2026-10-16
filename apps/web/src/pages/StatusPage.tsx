import { useEffect, useState } from "react";
import type { ReadinessResponse } from "@copilot/shared";
import { Card } from "../components/ui/Card";
import { fetchReadiness } from "../lib/api";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ReadinessResponse };

function Row({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <span className="font-medium">{label}</span>
      <span className="flex items-center gap-2 text-sm text-slate-600">
        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
        {detail}
      </span>
    </li>
  );
}

/** Public diagnostics page (kept from the foundation step). Reveals no secrets or user data. */
export default function StatusPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchReadiness(controller.signal)
      .then((data) => setState({ kind: "ready", data }))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setState({ kind: "error" });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
      <Card className="mt-6" aria-live="polite">
        {state.kind === "loading" && <p className="text-sm text-slate-600">Checking services…</p>}
        {state.kind === "error" && (
          <p role="alert" className="text-sm text-amber-700">
            Cannot reach the API. Is the backend running on port 3001?
          </p>
        )}
        {state.kind === "ready" && (
          <ul className="divide-y divide-slate-100">
            <Row label="Frontend" ok detail="Running" />
            <Row label="API" ok detail="Reachable" />
            <Row
              label="Database"
              ok={state.data.database.ok}
              detail={state.data.database.ok ? "Connected" : (state.data.database.error ?? "Unavailable")}
            />
            <Row label="AI provider" ok={!state.data.ai.isMock && state.data.ai.provider !== "disabled"} detail={state.data.ai.provider === "disabled" ? "Disabled for this deployment" : state.data.ai.isMock ? "DEMO mock" : state.data.ai.provider === "free-ai" ? "Google Gemini (online; no fallback)" : "AI provider unavailable"} />
          </ul>
        )}
      </Card>
    </main>
  );
}
