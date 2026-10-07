import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, AuditList } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Pagination, paginate } from "../components/ui/Pagination";
import { Skeleton, SkeletonRegion } from "../components/ui/Skeleton";
import { AdminOnly } from "../features/access/AdminOnly";
import { fetchAuditLog } from "../lib/adminApi";
import { friendlyMessage } from "../lib/errors";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One plain sentence per recorded action. Unknown (future) actions are shown as their code, never hidden. */
export function describeAudit(e: Pick<AuditEntry, "action" | "actorName" | "targetName">): string {
  const actor = e.actorName ?? "A deleted account";
  const target = e.targetName ?? "an account";
  switch (e.action) {
    case "access_paused":
      return `${actor} paused access for ${target}`;
    case "access_restored":
      return `${actor} restored access for ${target}`;
    case "bug_in_progress":
      return `${actor} moved a bug report to In progress`;
    case "bug_resolved":
      return `${actor} marked a bug report as resolved`;
    case "bug_reopened":
      return `${actor} reopened a bug report`;
    default:
      return `${actor}: ${e.action}`;
  }
}

type RangeKey = "today" | "week" | "month" | "7d" | "30d" | "all" | "custom";
const RANGES: Array<{ key: Exclude<RangeKey, "custom">; label: string }> = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const inputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The chosen range as ISO timestamps in the browser's own time zone (end exclusive). "All time" has no bounds. */
export function rangeBounds(key: Exclude<RangeKey, "custom">, now = new Date()): { from?: string; to?: string } {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  switch (key) {
    case "today":
      return { from: today.toISOString(), to: tomorrow.toISOString() };
    case "week": {
      const monday = addDays(today, -((today.getDay() + 6) % 7));
      return { from: monday.toISOString(), to: tomorrow.toISOString() };
    }
    case "month":
      return { from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(), to: tomorrow.toISOString() };
    case "7d":
      return { from: addDays(today, -6).toISOString(), to: tomorrow.toISOString() };
    case "30d":
      return { from: addDays(today, -29).toISOString(), to: tomorrow.toISOString() };
    case "all":
      return {};
  }
}

/** A plain CSV of the entries on screen (one row per entry). Quotes are doubled and leading =,+,-,@ neutralised so a spreadsheet cannot run them. */
export function auditCsv(entries: readonly AuditEntry[]): string {
  const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
  return [["When", "Action", "By", "Account", "Summary"].map(cell).join(","), ...entries.map((e) => [e.createdAt, e.action, e.actorName ?? "", e.targetName ?? "", describeAudit(e)].map(cell).join(","))].join("\r\n");
}

function Stat({ label, value, hint, tone = "text-brand-700" }: { label: string; value: number | string; hint?: string; tone?: string }) {
  return (
    <Card className="!p-5">
      <p className="font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">{label}</p>
      <p className={`mt-2 font-mono text-4xl font-semibold ${tone}`}>{value}</p>
      {hint && <p className="mt-2 text-sm text-slate-600">{hint}</p>}
    </Card>
  );
}

const TABS = ["Overview", "Activity", "Access changes"] as const;
type Tab = (typeof TABS)[number];

/** Administrators only: what admins did and how the accounts are being used. Names and times only, never any study content. */
export default function AdminAuditLogPage() {
  return (
    <AdminOnly>
      <Log />
    </AdminOnly>
  );
}

function Log() {
  const { client } = useAuth();
  const [tab, setTab] = useState<Tab>("Overview");
  const [range, setRange] = useState<RangeKey>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<AuditList | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const bounds = useMemo(() => {
    if (range !== "custom") return rangeBounds(range);
    return {
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: addDays(new Date(`${to}T00:00:00`), 1).toISOString() } : {}),
    };
  }, [range, from, to]);

  // Changing the tab or the date range always starts again at page 1.
  useEffect(() => setPage(1), [tab, bounds]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchAuditLog(client, bounds));
    } catch (err) {
      setError(friendlyMessage(err, "The audit log could not be loaded. Please try again."));
    }
  }, [client, bounds]);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = useMemo(() => (data?.entries ?? []).filter((e) => tab !== "Access changes" || e.action.startsWith("access_")), [data, tab]);

  function download() {
    const blob = new Blob([auditCsv(entries)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${inputDate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const s = data?.summary;
  const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-brand-700">Audit Log</h1>
          <p className="mt-1 text-sm text-slate-600">What administrators did and how accounts are used. Entries cannot be edited or deleted.</p>
        </div>
        <Button onClick={download} disabled={!data || entries.length === 0}>
          Generate report
        </Button>
      </div>

      {error ? (
        <div className="mt-6">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      ) : !data || !s ? (
        <SkeletonRegion label="Loading the audit log" className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </SkeletonRegion>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active users · 24h" value={s.activeUsers24h} hint="Signed in during the last day" />
            <Stat label="Actions · 24h" value={s.actions24h} hint="Admin changes in the last day" />
            <Stat label="Paused · range" value={s.inRange.paused} hint={`${s.inRange.restored} restored`} tone="text-amber-700" />
            <Stat label="Bug updates · range" value={s.inRange.bugChanges} hint="Moves across the Bug Tracker" tone="text-blue-700" />
          </div>

          <div role="tablist" aria-label="Audit log sections" className="mt-6 flex gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
                {t}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-slate-100 p-3 ring-1 ring-slate-200/70">
            <span className="font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">Filter</span>
            <div role="group" aria-label="Date range" className="flex flex-wrap gap-1 rounded-full bg-white p-1 ring-1 ring-slate-200">
              {RANGES.map((r) => (
                <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)} className={`rounded-full px-3.5 py-2 text-sm font-medium transition ${range === r.key ? "bg-brand-600 text-white" : "text-slate-600 hover:text-slate-900"}`}>
                  {r.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <span className="sr-only">From date</span>
              <input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setRange("custom"); }} className="h-10 rounded-xl bg-white px-3 text-sm ring-1 ring-slate-300" />
              <span aria-hidden="true">→</span>
              <input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setRange("custom"); }} className="h-10 rounded-xl bg-white px-3 text-sm ring-1 ring-slate-300" />
            </label>
            <span className="ml-auto text-xs text-slate-600">Times are shown in your local time.</span>
          </div>

          {tab === "Overview" ? (
            <Card className="mt-4 !p-0 sm:!p-0">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-brand-700">Adoption</h2>
                <span className="text-xs text-slate-600">All accounts, counted now</span>
              </div>
              <dl className="grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-5">
                {[
                  { k: "Signed in · 30 days", v: s.accounts.signedIn30d, h: `of ${s.accounts.total} accounts · ${pct(s.accounts.signedIn30d, s.accounts.total)}`, tone: "text-emerald-700" },
                  { k: "Never signed in", v: s.accounts.neverSignedIn, h: "accounts with no sign-in ever", tone: "text-red-700" },
                  { k: "Dormant", v: s.accounts.dormant30d, h: "signed in once, nothing in 30 days", tone: "text-amber-700" },
                  { k: "Active accounts", v: s.accounts.active, h: "can use the app", tone: "text-brand-700" },
                  { k: "Paused accounts", v: s.accounts.paused, h: "deactivated by an admin", tone: "text-slate-700" },
                ].map((x) => (
                  <div key={x.k} className="px-5 py-4">
                    <dt className="font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">{x.k}</dt>
                    <dd className={`mt-1 font-mono text-3xl font-semibold ${x.tone}`}>{x.v}</dd>
                    <p className="mt-1 text-sm text-slate-600">{x.h}</p>
                  </div>
                ))}
              </dl>
            </Card>
          ) : null}

          <Card className="mt-4">
            <h2 className="text-base font-semibold">{tab === "Access changes" ? "Access changes" : "Activity"}</h2>
            {entries.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">Nothing was recorded in this range.</p>
            ) : (
              <>
                <ol aria-label="Audit log" className="mt-1 divide-y divide-slate-100">
                  {paginate(entries, page).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                      <span className="text-sm text-slate-900">{describeAudit(e)}</span>
                      <time dateTime={e.createdAt} className="font-mono text-xs text-slate-600">
                        {when(e.createdAt)}
                      </time>
                    </li>
                  ))}
                </ol>
                <Pagination page={page} total={entries.length} onPage={setPage} label="Audit log pagination" compact />
                {data.truncated && <p className="mt-3 text-xs text-slate-600">Showing the newest {data.entries.length} entries. Narrow the date range to see older ones.</p>}
              </>
            )}
          </Card>
          <p className="mt-3 text-xs text-slate-600">Only things this app records are counted: admin actions and each account&apos;s last sign-in time. Failed sign-ins and page views are not recorded.</p>
        </>
      )}
    </div>
  );
}
