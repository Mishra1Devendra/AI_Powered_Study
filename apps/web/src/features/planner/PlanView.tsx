import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { PlanDetailResponse, SessionAction, UpdatePlanInput } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { ApiError } from "../../lib/api";
import { activatePlan, regeneratePlan, sessionAction, updatePlan } from "../../lib/plannerApi";
import { PlanStatusBadge } from "./Badges";
import { Dialog } from "./Dialog";
import { EditPlanDialog } from "./EditPlanDialog";
import { MissedSessions } from "./MissedSessions";
import { PlanGenerationSteps } from "./PlanGenerationSteps";
import { PlanHeader } from "./PlanHeader";
import { SessionDialog } from "./SessionDialog";
import { WeekView } from "./WeekView";
import { usePlannerPaths } from "./paths";

interface Props {
  data: PlanDetailResponse;
  /** Re-reads the plan quietly after a change. */
  refresh: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

/** Everything about one plan: creation progress, or the header, missed sessions and the weekly schedule. */
export function PlanView({ data, refresh }: Props) {
  const { client } = useAuth();
  const p = usePlannerPaths();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { plan, sessions, today } = data;
  const editable = plan.status === "active";
  const [editing, setEditing] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [busy, setBusy] = useState<"regenerate" | "activate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  // Synchronous guard: a fast double click must never start two AI generations.
  const regenerating = useRef(false);

  const openId = params.get("session");
  const open = sessions.find((s) => s.id === openId) ?? null;
  const movedTo = open ? (sessions.find((s) => s.id === open.rescheduledToId) ?? null) : null;
  const setOpen = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("session", id);
        else next.delete("session");
        return next;
      },
      { replace: true },
    );

  const undecidedMissed = useMemo(() => sessions.filter((s) => s.effectiveStatus === "missed" && s.status !== "missed"), [sessions]);

  async function act(sessionId: string, action: SessionAction, body?: { date?: string }) {
    const res = await sessionAction(client, sessionId, action, body);
    await refresh();
    // After a reschedule from the dialog, show where the session went.
    if (action === "reschedule" && res.created && openId === sessionId) setOpen(res.created.id);
  }

  async function regenerate() {
    if (regenerating.current) return;
    regenerating.current = true;
    setBusy("regenerate");
    setError(null);
    setBusyPlanId(null);
    try {
      const next = await regeneratePlan(client, plan.id);
      setConfirmRegen(false);
      navigate(p.plan(next.id));
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && typeof e.body?.planId === "string") setBusyPlanId(e.body.planId);
      setConfirmRegen(false);
    } finally {
      regenerating.current = false;
      setBusy(null);
    }
  }

  async function activate() {
    setBusy("activate");
    setError(null);
    try {
      await activatePlan(client, plan.id);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(patch: UpdatePlanInput) {
    await updatePlan(client, plan.id, patch);
    setEditing(false);
    await refresh();
  }

  const errorBox = error && (
    <Alert tone="error">
      {error}
      {busyPlanId && (
        <>
          {" "}
          <Link to={p.plan(busyPlanId)} className="font-semibold underline">
            See the plan being created
          </Link>
        </>
      )}
    </Alert>
  );

  if (plan.status === "generating") {
    return (
      <div className="mx-auto max-w-xl rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70 sm:p-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{plan.title}</h1>
          <PlanStatusBadge status={plan.status} />
        </div>
        <PlanGenerationSteps progress={plan.progress} />
        <p className="mt-5 text-sm text-slate-600">You can leave this page; the plan keeps being created and will be here when you come back.</p>
      </div>
    );
  }

  if (plan.status === "failed") {
    return (
      <div className="mx-auto max-w-xl space-y-4 rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{plan.title}</h1>
          <PlanStatusBadge status={plan.status} />
        </div>
        <Alert tone="error">{plan.error ?? "The plan could not be created."}</Alert>
        <p className="text-sm text-slate-600">Nothing was saved, and your current plan (if you have one) is unchanged.</p>
        {errorBox}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void regenerate()} loading={busy === "regenerate"}>
            Try again
          </Button>
          <Link to={`${p.create}?from=${plan.id}`} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
            Change settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {plan.status === "archived" && (
        <div className="flex flex-col gap-3 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-800 sm:flex-row sm:items-center sm:justify-between">
          <span>This is a previous plan, kept with its history. Its sessions can&apos;t be changed unless you make it active again.</span>
          <Button variant="secondary" className="shrink-0" onClick={() => void activate()} loading={busy === "activate"}>
            Make this plan active
          </Button>
        </div>
      )}
      <PlanHeader plan={plan} today={today} />
      {errorBox}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit plan
          </Button>
          <Button variant="secondary" onClick={() => setConfirmRegen(true)}>
            Regenerate
          </Button>
          <Link to={`${p.create}?from=${plan.id}`} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-brand-700 hover:bg-brand-50">
            New plan from these settings
          </Link>
        </div>
      )}
      {editable && <MissedSessions sessions={undecidedMissed} onAction={(id, action) => act(id, action)} />}
      <div className="rounded-(--radius-card) bg-white p-4 shadow-card ring-1 ring-slate-200/70 sm:p-5">
        <WeekView sessions={sessions} startDate={plan.startDate} examDate={plan.examDate} today={today} studyDays={plan.studyDays} focusDate={open?.date ?? null} onOpen={(s) => setOpen(s.id)} />
      </div>

      {open && <SessionDialog key={open.id} session={open} movedTo={movedTo} today={today} examDate={plan.examDate} editable={editable} onAction={(action, body) => act(open.id, action, body)} onVerified={refresh} onClose={() => setOpen(null)} />}
      {editing && <EditPlanDialog plan={plan} today={today} onSave={save} onClose={() => setEditing(false)} />}
      {confirmRegen && (
        <Dialog title="Regenerate this plan?" onClose={() => setConfirmRegen(false)} busy={busy === "regenerate"}>
          <p className="text-sm text-slate-700">A new plan is created with the same settings (one request to your local AI). This plan and its progress are kept under Previous plans - nothing is deleted.</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" data-initial-focus onClick={() => setConfirmRegen(false)} disabled={busy === "regenerate"}>
              Cancel
            </Button>
            <Button onClick={() => void regenerate()} loading={busy === "regenerate"}>
              Create new plan
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
