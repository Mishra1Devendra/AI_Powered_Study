import { useCallback, useEffect, useState } from "react";
import type { AiStatusReport, AiStepStatus } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton, SkeletonRegion } from "../components/ui/Skeleton";
import { AdminOnly } from "../features/access/AdminOnly";
import { fetchAiStatus } from "../lib/adminApi";
import { friendlyMessage } from "../lib/errors";

const STATE: Record<AiStepStatus["state"], { label: string; classes: string }> = {
  ready: { label: "Ready", classes: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  resting: { label: "Resting (limit reached)", classes: "bg-amber-50 text-amber-900 ring-amber-200" },
  not_running: { label: "Not running", classes: "bg-red-50 text-red-800 ring-red-200" },
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never");

/** "12 of 1,000 today" / "12 today (no fixed limit published)". Counts are requests started since the server last started. */
export function usageText(s: Pick<AiStepStatus, "usedToday" | "limitPerDay" | "limitPerMinute">): string {
  const limit = s.limitPerDay !== null ? ` of ${s.limitPerDay.toLocaleString()}` : "";
  const rate = s.limitPerMinute !== null ? ` · up to ${s.limitPerMinute}/min` : "";
  const none = s.limitPerDay === null && s.limitPerMinute === null ? " · no fixed limit" : "";
  return `${s.usedToday.toLocaleString()}${limit} today${rate}${none}`;
}

function Step({ s }: { s: AiStepStatus }) {
  const st = STATE[s.state];
  const nearLimit = s.limitPerDay !== null && s.usedToday / s.limitPerDay >= 0.8;
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">{s.order}</span>
        <p className="text-sm font-semibold text-slate-900">{s.service}</p>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${st.classes}`}>
          {st.label}
          {s.state === "resting" && s.restingSeconds > 0 ? ` · ${s.restingSeconds}s` : ""}
        </span>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700">{s.where === "online" ? "Online" : "This computer"}</span>
      </div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-slate-600">Model</dt>
        <dd className="break-all font-medium text-slate-900">{s.model}</dd>
        <dt className="text-slate-600">Used</dt>
        <dd className={`font-medium ${nearLimit ? "text-amber-800" : "text-slate-900"}`}>{usageText(s)}</dd>
        <dt className="text-slate-600">Free limit</dt>
        <dd className="text-slate-800">{s.limitNote}</dd>
        <dt className="text-slate-600">Last result</dt>
        <dd className="text-slate-800">
          {s.lastResult ?? "Not asked yet"}
          {s.lastAt ? ` · ${when(s.lastAt)}` : ""}
        </dd>
      </dl>
    </li>
  );
}

/** Administrators only: which AI is answering, in what order, and each service's free limit. Reading this screen makes no AI request. */
export default function AdminAiStatusPage() {
  return (
    <AdminOnly>
      <Status />
    </AdminOnly>
  );
}

function Status() {
  const { client } = useAuth();
  const [data, setData] = useState<AiStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchAiStatus(client));
    } catch (err) {
      setError(friendlyMessage(err, "The AI status could not be loaded. Please try again."));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI status</h1>
          <p className="mt-1 text-sm text-slate-600">Which AI answers, in what order, and each one&apos;s free limit. Only administrators can see this. Students see only &ldquo;Free AI&rdquo;.</p>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="mt-6">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      ) : !data ? (
        <SkeletonRegion label="Loading the AI status" className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </SkeletonRegion>
      ) : (
        <>
          <Card className="mt-6">
            <h2 className="text-base font-semibold">Working now</h2>
            {data.lastAnswered ? (
              <p className="mt-2 text-sm text-slate-800">
                The last answer came from <span className="font-semibold text-slate-900">{data.lastAnswered.service}</span> (<span className="break-all">{data.lastAnswered.model}</span>) at {when(data.lastAnswered.at)}.
              </p>
            ) : (
              <p className="mt-2 text-sm text-slate-600">No question has been answered since the server started. Ask something in the Tutor, then refresh.</p>
            )}
            <p className="mt-2 text-xs text-slate-600">
              {data.mode === "free"
                ? data.localPosition === "last"
                  ? "Order: free online services first, the local AI only when they cannot answer."
                  : "Order: the local AI first, free online services as the backup."
                : data.mode === "mock"
                  ? "Demo mode: canned replies only."
                  : "Local AI only (no free online service is configured)."}{" "}
              Counts start from {when(data.countersSince)} and reset when the server restarts.
            </p>
          </Card>

          <Card className="mt-4">
            <h2 className="text-base font-semibold">Order tried for each question</h2>
            <ol aria-label="AI services in the order they are tried" className="mt-1 divide-y divide-slate-100">
              {data.steps.map((s) => (
                <Step key={`${s.order}-${s.service}`} s={s} />
              ))}
            </ol>
            <p className="mt-2 text-xs text-slate-600">If every service is unavailable, students see &ldquo;All free AI services are currently unavailable. Please try again later.&rdquo; Nothing paid is ever used.</p>
          </Card>
        </>
      )}
    </div>
  );
}
