import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanDetailResponse, PlanListResponse, PlanOptions } from "@copilot/shared";
import { getPlan, getPlanOptions, listPlans } from "../../lib/plannerApi";
import { useLoad } from "../quiz/useQuizData";

/** Polls only while a plan is being created (one cheap query); never for AI work of its own. */
const POLL_MS = 3000;

export function usePlanList(client: SupabaseClient) {
  return useLoad<PlanListResponse>(() => listPlans(client), [client], (d) => d.plans.some((p) => p.status === "generating"), POLL_MS);
}

export function usePlanDetail(client: SupabaseClient, planId: string | null) {
  const result = useLoad<PlanDetailResponse | null>(() => (planId ? getPlan(client, planId) : Promise.resolve(null)), [client, planId], (d) => d?.plan.status === "generating", POLL_MS);
  const notFound = result.state.status === "error" && /not found/i.test(result.state.message);
  return { ...result, notFound };
}

export function usePlanOptions(client: SupabaseClient) {
  return useLoad<PlanOptions>(() => getPlanOptions(client), [client]);
}
