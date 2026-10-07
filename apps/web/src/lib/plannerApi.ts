import type { SupabaseClient } from "@supabase/supabase-js";
import {
  latestCheckResponseSchema,
  planDetailResponseSchema,
  planListResponseSchema,
  planOptionsSchema,
  planResponseSchema,
  sessionActionResponseSchema,
  startCheckResponseSchema,
  submitCheckResponseSchema,
  type PlanDetailResponse,
  type PlanInput,
  type PlanListResponse,
  type PlanOptions,
  type SessionAction,
  type SessionActionResponse,
  type SessionCheck,
  type StudyPlan,
  type SubmitCheckInput,
  type SubmitCheckResponse,
  type UpdatePlanInput,
} from "@copilot/shared";
import { request } from "./api";

const BASE = "/api/study-plans";
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const getPlanOptions = (client: SupabaseClient): Promise<PlanOptions> => request(client, `${BASE}/options`, planOptionsSchema);

/** Starts creating a plan. Returns at once with status "generating"; poll `getPlan` until it is ready. */
export async function generatePlan(client: SupabaseClient, input: PlanInput): Promise<StudyPlan> {
  return (await request(client, `${BASE}/generate`, planResponseSchema, post(input))).plan;
}

export const listPlans = (client: SupabaseClient): Promise<PlanListResponse> => request(client, BASE, planListResponseSchema);
export const getPlan = (client: SupabaseClient, id: string): Promise<PlanDetailResponse> => request(client, `${BASE}/${id}`, planDetailResponseSchema);

export async function updatePlan(client: SupabaseClient, id: string, patch: UpdatePlanInput): Promise<StudyPlan> {
  return (await request(client, `${BASE}/${id}`, planResponseSchema, { method: "PATCH", body: JSON.stringify(patch) })).plan;
}

/** A NEW plan with the same settings. The current plan is kept (archived once the new one is ready). */
export async function regeneratePlan(client: SupabaseClient, id: string): Promise<StudyPlan> {
  return (await request(client, `${BASE}/${id}/regenerate`, planResponseSchema, post())).plan;
}

export async function activatePlan(client: SupabaseClient, id: string): Promise<StudyPlan> {
  return (await request(client, `${BASE}/${id}/activate`, planResponseSchema, post())).plan;
}

export const sessionAction = (client: SupabaseClient, sessionId: string, action: SessionAction, body?: { date?: string }): Promise<SessionActionResponse> =>
  request(client, `/api/study-sessions/${sessionId}/${action}`, sessionActionResponseSchema, post(body ?? {}));

/* ---- Study check: 5 questions before a session can be marked complete ---- */

/** Starts (or returns the open) question set. Writing the questions takes a while: poll `getSessionCheck`. */
export async function startSessionCheck(client: SupabaseClient, sessionId: string): Promise<SessionCheck> {
  return (await request(client, `/api/study-sessions/${sessionId}/check`, startCheckResponseSchema, post())).check;
}

export async function getSessionCheck(client: SupabaseClient, sessionId: string): Promise<SessionCheck | null> {
  return (await request(client, `/api/study-sessions/${sessionId}/check`, latestCheckResponseSchema)).check;
}

export const submitSessionCheck = (client: SupabaseClient, sessionId: string, checkId: string, answers: SubmitCheckInput["answers"]): Promise<SubmitCheckResponse> =>
  request(client, `/api/study-sessions/${sessionId}/check/${checkId}/answers`, submitCheckResponseSchema, post({ answers }));
