import { AI_COST } from "@copilot/shared";
import { AiUsageNote } from "../features/ai-usage/AiUsageNote";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { PlanInput } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { PlanProvenance } from "../features/planner/Badges";
import { CreatePlanForm } from "../features/planner/CreatePlanForm";
import { usePlannerPaths } from "../features/planner/paths";
import { usePlanOptions } from "../features/planner/usePlannerData";
import { ApiError } from "../lib/api";
import { generatePlan, getPlan } from "../lib/plannerApi";
import { fetchHealth } from "../lib/tutorApi";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/study-plan/new`: the plan form. `?from=<planId>` starts from an earlier plan's settings. */
export default function StudyPlanCreatePage() {
  const p = usePlannerPaths();
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const from = params.get("from");
  const options = usePlanOptions(client);
  const [initial, setInitial] = useState<Partial<PlanInput> | null | undefined>(from && UUID.test(from) ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [ai, setAi] = useState<{ isMock: boolean; model: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((h) => setAi({ isMock: h.ai.isMock, model: h.ai.model }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!from || !UUID.test(from)) return;
    let live = true;
    getPlan(client, from)
      .then(({ plan }) => live && setInitial({ title: plan.title, examDate: plan.examDate, targetScore: plan.targetScore, minutesPerDay: plan.minutesPerDay, knowledgeLevel: plan.knowledgeLevel, subjects: plan.subjects, studyDays: plan.studyDays, preferredTime: plan.preferredTime }))
      .catch(() => live && setInitial(null));
    return () => {
      live = false;
    };
  }, [client, from]);

  async function onSubmit(input: PlanInput) {
    setError(null);
    setBusyPlanId(null);
    try {
      const plan = await generatePlan(client, input);
      navigate(p.plan(plan.id));
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        if (typeof e.body?.planId === "string") setBusyPlanId(e.body.planId);
      } else {
        setError("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <div className="animate-fade-up mx-auto max-w-3xl">
      <Link to={p.home} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 -ml-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> Study plan
      </Link>
      <header className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create a study plan</h1>
          <p className="mt-1 text-sm text-slate-600">Google Gemini chooses the topics when AI is enabled; the app fits them into your days before your exam.</p>
        </div>
        {ai && (
          <div className="text-right text-xs text-slate-600">
            Topics by
            <div className="mt-1">
              <PlanProvenance isMock={ai.isMock} model={ai.model} />
            </div>
          </div>
        )}
      </header>
      <AiUsageNote cost={AI_COST.planner} className="mt-4" />
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        When enabled, subjects, topics, and study-plan details may be sent to Google Gemini. Google&apos;s unpaid-tier terms say submitted content may be used to improve products and may be reviewed by humans. AI generation is currently unavailable while model free-tier eligibility is unverified.
      </p>

      <div className="mt-6 rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-7">
        {(options.state.status === "loading" || initial === undefined) && (
          <LoadingState label="Loading…" />
        )}
        {options.state.status === "error" && (
          <ErrorState message={options.state.message} onRetry={() => void options.reload()} />
        )}
        {options.state.status === "ready" && initial !== undefined && <CreatePlanForm options={options.state.data} initial={initial ?? undefined} onSubmit={onSubmit} error={error} busyPlanId={busyPlanId} />}
      </div>
    </div>
  );
}
