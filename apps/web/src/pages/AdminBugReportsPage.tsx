import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { BUG_SEVERITY_LABEL, BUG_STATUS_LABEL, BUG_TYPE_LABEL, type BugReport, type BugReportList, type BugSeverity, type BugStatus, type BugType } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Pagination, paginate } from "../components/ui/Pagination";
import { Skeleton, SkeletonRegion } from "../components/ui/Skeleton";
import { AdminOnly } from "../features/access/AdminOnly";
import { BugDetailDialog } from "../features/admin/BugDetailDialog";
import { fetchBugReports, setBugStatus } from "../lib/adminApi";
import { friendlyMessage } from "../lib/errors";

const COLUMNS: Array<{ status: BugStatus; hint: string; accent: string; text: string }> = [
  { status: "open", hint: "Reported, not yet picked up", accent: "border-t-blue-500", text: "text-blue-700" },
  { status: "in_progress", hint: "Being worked on", accent: "border-t-amber-500", text: "text-amber-700" },
  { status: "resolved", hint: "Fixed & closed", accent: "border-t-emerald-500", text: "text-emerald-700" },
];

const SEVERITY_TEXT: Record<BugSeverity, string> = { low: "text-slate-600", medium: "text-amber-700", high: "text-red-700" };
const TYPE_CHIP: Record<BugType, string> = { bug: "bg-red-600 text-white", feature: "bg-violet-600 text-white", other: "bg-slate-600 text-white" };
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const DRAG_TYPE = "application/x-bug-report";

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: string }) {
  return (
    <Card className="!p-5">
      <p className="font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">{label}</p>
      <p className={`mt-2 font-mono text-4xl font-semibold ${tone}`}>{value}</p>
      <p className="mt-2 text-sm text-slate-600">{hint}</p>
    </Card>
  );
}

function BugCard({ r, busy, onMove, onOpen }: { r: BugReport; busy: boolean; onMove: (r: BugReport, s: BugStatus) => void; onOpen: (r: BugReport) => void }) {
  const others = COLUMNS.filter((c) => c.status !== r.status);
  return (
    <li
      draggable={!busy}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, r.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      aria-label={`${r.title}, ${BUG_STATUS_LABEL[r.status]}`}
      onClick={(e) => {
        // Clicking anywhere on the card opens it, except on its own small buttons.
        if (!(e.target as HTMLElement).closest("button")) onOpen(r);
      }}
      className={`rounded-2xl bg-white p-3.5 shadow-card ring-1 ring-slate-200/70 transition ${busy ? "opacity-60" : "cursor-pointer hover:ring-brand-500/40 active:cursor-grabbing"}`}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wide">
        <span className={`font-mono ${SEVERITY_TEXT[r.severity]}`}>{BUG_SEVERITY_LABEL[r.severity]}</span>
        <span className={`rounded px-1.5 py-0.5 ${TYPE_CHIP[r.type]}`}>{BUG_TYPE_LABEL[r.type]}</span>
        {r.page && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono font-normal normal-case tracking-normal text-slate-600">{r.page}</span>}
      </div>
      <h3 className="mt-2 text-sm font-semibold leading-snug text-brand-700">
        <button type="button" onClick={() => onOpen(r)} aria-label={`Open report: ${r.title}`} className="-my-2.5 py-2.5 text-left hover:underline focus-visible:underline">
          {r.title}
        </button>
      </h3>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-slate-600">{r.description}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs text-slate-600">
        <span>
          <span className="font-semibold text-slate-800">{r.reporterName ?? "Unknown"}</span> · {when(r.createdAt)}
        </span>
        <span className="flex gap-1">
          {others.map((c) => (
            <button
              key={c.status}
              type="button"
              disabled={busy}
              onClick={() => onMove(r, c.status)}
              aria-label={`Move "${r.title}" to ${BUG_STATUS_LABEL[c.status]}`}
              className="rounded-md px-2.5 py-2.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            >
              → {BUG_STATUS_LABEL[c.status]}
            </button>
          ))}
        </span>
      </div>
    </li>
  );
}

/** Administrators only. The Bug Tracker: reports sent with "Report a bug", worked across Open / In progress / Resolved. */
export default function AdminBugReportsPage() {
  return (
    <AdminOnly>
      <Board />
    </AdminOnly>
  );
}

function Board() {
  const { client } = useAuth();
  const [data, setData] = useState<BugReportList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [type, setType] = useState<"all" | BugType>("all");
  const [severity, setSeverity] = useState<"all" | BugSeverity>("all");
  const [q, setQ] = useState("");
  const [over, setOver] = useState<BugStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pages, setPages] = useState<Record<BugStatus, number>>({ open: 1, in_progress: 1, resolved: 1 });

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchBugReports(client));
    } catch (err) {
      setError(friendlyMessage(err, "The reports could not be loaded. Please try again."));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.reports ?? []).filter((r) => (type === "all" || r.type === type) && (severity === "all" || r.severity === severity) && (!needle || r.title.toLowerCase().includes(needle) || (r.reporterName ?? "").toLowerCase().includes(needle)));
  }, [data, type, severity, q]);

  // A new filter or search always starts every column again at page 1.
  useEffect(() => setPages({ open: 1, in_progress: 1, resolved: 1 }), [type, severity, q]);
  const opened = data?.reports.find((r) => r.id === openId) ?? null;

  async function move(r: BugReport, status: BugStatus) {
    if (r.status === status) return;
    setBusyId(r.id);
    setActionError(null);
    try {
      const updated = await setBugStatus(client, r.id, status);
      setData((d) => {
        if (!d) return d;
        const reports = d.reports.map((x) => (x.id === updated.id ? updated : x));
        const n = (s: BugStatus) => reports.filter((x) => x.status === s).length;
        return { ...d, reports, counts: { total: reports.length, open: n("open"), in_progress: n("in_progress"), resolved: n("resolved") } };
      });
    } catch (err) {
      setActionError(friendlyMessage(err, "That change could not be saved. Please try again."));
    } finally {
      setBusyId(null);
    }
  }

  const select = "h-10 rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600";

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-brand-700">Bug Tracker</h1>
      <p className="mt-1 text-sm text-slate-600">Reports filed from the &ldquo;Report a bug&rdquo; button. Drag a card across the columns (or use its arrow buttons) as you work on it and close it.</p>

      {error ? (
        <div className="mt-6">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      ) : !data ? (
        <SkeletonRegion label="Loading reports" className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </SkeletonRegion>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total reports" value={data.counts.total} hint="All time" tone="text-brand-700" />
            <Stat label="Open" value={data.counts.open} hint="Not yet picked up" tone="text-blue-700" />
            <Stat label="In progress" value={data.counts.in_progress} hint="Being worked on" tone="text-amber-700" />
            <Stat label="Resolved" value={data.counts.resolved} hint="Fixed & closed" tone="text-emerald-700" />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">Filter</span>
            <label className="sr-only" htmlFor="bug-type">
              Type
            </label>
            <select id="bug-type" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={select}>
              <option value="all">All types</option>
              {(Object.keys(BUG_TYPE_LABEL) as BugType[]).map((t) => (
                <option key={t} value={t}>
                  {BUG_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="bug-severity">
              Severity
            </label>
            <select id="bug-severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} className={select}>
              <option value="all">Severity</option>
              {(Object.keys(BUG_SEVERITY_LABEL) as BugSeverity[]).map((s) => (
                <option key={s} value={s}>
                  {BUG_SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="bug-search">
              Search title or reporter
            </label>
            <input id="bug-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title / reporter…" className={`${select} min-w-56 flex-1 sm:max-w-sm`} />
          </div>

          {actionError && (
            <div className="mt-4">
              <Alert tone="error">{actionError}</Alert>
            </div>
          )}

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {COLUMNS.map((c) => {
              const items = visible.filter((r) => r.status === c.status);
              return (
                <section
                  key={c.status}
                  aria-label={`${BUG_STATUS_LABEL[c.status]} reports`}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                      e.preventDefault();
                      setOver(c.status);
                    }
                  }}
                  onDragLeave={() => setOver((o) => (o === c.status ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    const id = e.dataTransfer.getData(DRAG_TYPE);
                    const r = data.reports.find((x) => x.id === id);
                    if (r) void move(r, c.status);
                  }}
                  className={`rounded-2xl border-t-4 bg-white ring-1 transition ${c.accent} ${over === c.status ? "ring-2 ring-brand-600" : "ring-slate-200/70"}`}
                >
                  <header className="flex items-start justify-between border-b border-slate-100 px-4 py-3.5">
                    <div>
                      <h2 className={`font-mono text-xs font-semibold uppercase tracking-widest ${c.text}`}>{BUG_STATUS_LABEL[c.status]}</h2>
                      <p className="mt-0.5 text-sm text-slate-600">{c.hint}</p>
                    </div>
                    <span className="font-mono text-xs text-slate-500">{items.length}</span>
                  </header>
                  <ul className="max-h-[32rem] space-y-3 overflow-y-auto p-3">
                    {items.length === 0 ? (
                      <li className="rounded-xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500">Nothing here</li>
                    ) : (
                      paginate(items, pages[c.status]).map((r) => <BugCard key={r.id} r={r} busy={busyId === r.id} onMove={(x, s) => void move(x, s)} onOpen={(x) => setOpenId(x.id)} />)
                    )}
                  </ul>
                  <Pagination page={pages[c.status]} total={items.length} onPage={(p) => setPages((cur) => ({ ...cur, [c.status]: p }))} label={`${BUG_STATUS_LABEL[c.status]} pagination`} compact />
                </section>
              );
            })}
          </div>
          {data.truncated && <p className="mt-3 text-xs text-slate-600">Showing the newest {data.reports.length} reports.</p>}
          {opened && <BugDetailDialog report={opened} busy={busyId === opened.id} onMove={(s) => void move(opened, s)} onClose={() => setOpenId(null)} />}
        </>
      )}
    </div>
  );
}
