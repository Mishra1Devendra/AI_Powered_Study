import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router";
import type { AdminStudent, AdminStudentList } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Pagination, paginate } from "../components/ui/Pagination";
import { SkeletonRegion, Skeleton } from "../components/ui/Skeleton";
import { useRoleState } from "../features/access/AccessGate";
import { fetchAdminStudents, setStudentAccess } from "../lib/adminApi";
import { friendlyMessage } from "../lib/errors";

const field = "h-11 rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 transition focus:outline-none focus:ring-2 focus:ring-brand-600";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

/** "Never" / "Today" / "3 d ago" / a date. Display only. */
export function lastSeen(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 30) return `${days} d ago`;
  return day(iso);
}

const chip = "inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[0.68rem] font-semibold uppercase tracking-wide ring-1";

function Row({ s, me, busy, onChange }: { s: AdminStudent; me: string | undefined; busy: boolean; onChange: (s: AdminStudent, status: "active" | "revoked") => void }) {
  const [confirming, setConfirming] = useState(false);
  const paused = s.accessStatus === "revoked";
  const isAdmin = s.role === "admin";
  return (
    <tr className="border-t border-slate-200 align-middle">
      <td className="px-4 py-3.5">
        <p className="text-sm font-semibold text-brand-700">
          {s.displayName}
          {s.id === me && <span className="ml-2 text-xs font-normal text-slate-600">(you)</span>}
        </p>
        <p className="font-mono text-xs text-slate-600">{s.email ?? "No email"}</p>
      </td>
      <td className="px-4 py-3.5">
        <span className={`${chip} ${isAdmin ? "bg-brand-50 text-brand-700 ring-brand-100" : "bg-slate-100 text-slate-700 ring-slate-300"}`}>{isAdmin ? "Admin" : "Student"}</span>
      </td>
      <td className="px-4 py-3.5">
        <span className={`${chip} ${paused ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"}`}>
          <span aria-hidden="true" className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
          {paused ? "Paused" : "Active"}
        </span>
      </td>
      <td className={`px-4 py-3.5 text-sm font-semibold ${paused ? "text-amber-800" : "text-emerald-700"}`}>{paused ? "No" : "Yes"}</td>
      <td className="whitespace-nowrap px-4 py-3.5 text-sm text-slate-600">{day(s.createdAt)}</td>
      <td className="whitespace-nowrap px-4 py-3.5 text-sm text-slate-600">{lastSeen(s.lastSignInAt)}</td>
      <td className="px-4 py-3.5 text-sm text-slate-600">
        {s.accessChangedAt ? (
          <>
            {paused ? "Paused" : "Restored"} by <span className="font-semibold text-brand-700">{s.accessChangedByName ?? "an admin"}</span>
            <span className="block text-xs text-slate-500">{day(s.accessChangedAt)}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3.5 text-right">
        {isAdmin ? (
          <span className="text-xs text-slate-500">Administrator</span>
        ) : paused ? (
          <Button variant="secondary" className="h-9 px-3.5" disabled={busy} loading={busy} onClick={() => onChange(s, "active")} aria-label={`Activate ${s.displayName}`}>
            Activate
          </Button>
        ) : confirming ? (
          <span className="inline-flex items-center gap-2">
            <Button className="h-9 px-3.5" disabled={busy} loading={busy} onClick={() => onChange(s, "revoked")} aria-label={`Confirm deactivating ${s.displayName}`}>
              Confirm
            </Button>
            <Button variant="ghost" className="h-9 px-3" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="secondary" className="h-9 px-3.5" disabled={busy} onClick={() => setConfirming(true)} aria-label={`Deactivate ${s.displayName}`}>
            Deactivate
          </Button>
        )}
      </td>
    </tr>
  );
}

/** Administrators only. Users & Access: every account, who paused or restored it, and when it last signed in. Shows no study content. */
export default function AdminPage() {
  const { role, ready } = useRoleState();
  const { client, user } = useAuth();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "revoked">("all");
  const [roleFilter, setRoleFilter] = useState<"all" | "student" | "admin">("all");
  const [data, setData] = useState<AdminStudentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchAdminStudents(client, debounced));
    } catch (err) {
      setError(friendlyMessage(err, "The list could not be loaded. Please try again."));
    }
  }, [client, debounced]);

  useEffect(() => {
    if (role === "admin") void load();
  }, [role, load]);

  const shown = useMemo(() => (data?.students ?? []).filter((s) => (status === "all" || s.accessStatus === status) && (roleFilter === "all" || s.role === roleFilter)), [data, status, roleFilter]);
  // A new search or filter always starts again at page 1.
  useEffect(() => setPage(1), [debounced, status, roleFilter]);
  const activeCount = (data?.students ?? []).filter((s) => s.accessStatus === "active").length;

  if (!ready) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <SkeletonRegion label="Checking your access" className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-24 w-full" />
        </SkeletonRegion>
      </div>
    );
  }
  if (role !== "admin") return <Navigate to="/dashboard" replace />;

  async function change(s: AdminStudent, next: "active" | "revoked") {
    setBusyId(s.id);
    setActionError(null);
    setNotice(null);
    try {
      const updated = await setStudentAccess(client, s.id, next);
      setData((d) => (d ? { ...d, students: d.students.map((x) => (x.id === updated.id ? updated : x)) } : d));
      setNotice(next === "revoked" ? `${s.displayName} was deactivated.` : `${s.displayName} was activated again.`);
    } catch (err) {
      setActionError(friendlyMessage(err, "That change could not be saved. Please try again."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-brand-700">Users &amp; Access</h1>
      <p className="mt-1 text-sm text-slate-600">
        {data ? `${data.total} ${data.total === 1 ? "user" : "users"} · ${activeCount} active` : "Loading…"} · You see account details only, never anyone&apos;s notes, chats or answers.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <label htmlFor="admin-search" className="sr-only">
          Search by name or email
        </label>
        <input id="admin-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={80} placeholder="Search name, email, role…" className={`${field} min-w-56 flex-1 sm:max-w-md`} />
        <label className="sr-only" htmlFor="admin-status">
          Status
        </label>
        <select id="admin-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={field}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Paused</option>
        </select>
        <label className="sr-only" htmlFor="admin-role">
          Role
        </label>
        <select id="admin-role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)} className={field}>
          <option value="all">All roles</option>
          <option value="student">Students</option>
          <option value="admin">Admins</option>
        </select>
      </div>

      {notice && (
        <div className="mt-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {actionError && (
        <div className="mt-4">
          <Alert tone="error">{actionError}</Alert>
        </div>
      )}

      <Card className="mt-4 overflow-hidden !p-0 sm:!p-0">
        {error ? (
          <div className="p-5">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        ) : !data ? (
          <SkeletonRegion label="Loading accounts" className="space-y-3 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </SkeletonRegion>
        ) : shown.length === 0 ? (
          <p className="p-5 text-sm text-slate-600">No accounts match that search or filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Accounts" className="w-full min-w-[56rem] text-left">
              <thead>
                <tr className="bg-slate-100 font-mono text-[0.68rem] uppercase tracking-widest text-slate-600">
                  {["User", "Role", "Status", "Active", "Joined", "Last sign-in", "Reviewed", "Actions"].map((h, i) => (
                    <th key={h} scope="col" className={`px-4 py-3 font-semibold ${i === 7 ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginate(shown, page).map((s) => (
                  <Row key={s.id} s={s} me={user?.id} busy={busyId === s.id} onChange={(st, next) => void change(st, next)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && !error && shown.length > 0 && <Pagination page={page} total={shown.length} onPage={setPage} label="Accounts pagination" />}
      </Card>
      {data?.truncated && <p className="mt-3 text-xs text-slate-600">Showing the first {data.students.length} of {data.total} accounts. Search to narrow the list.</p>}
    </div>
  );
}
