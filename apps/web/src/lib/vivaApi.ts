import type { SupabaseClient } from "@supabase/supabase-js";
import { vivaDetailSchema, vivaListResponseSchema, vivaOptionsSchema, type AnswerVivaInput, type CreateVivaRequest, type VivaDetail, type VivaListResponse, type VivaOptions } from "@copilot/shared";
import { request } from "./api";

const BASE = "/api/viva";
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const getVivaOptions = (client: SupabaseClient): Promise<VivaOptions> => request(client, `${BASE}/options`, vivaOptionsSchema);
export const listVivas = (client: SupabaseClient): Promise<VivaListResponse> => request(client, `${BASE}/sessions`, vivaListResponseSchema);
export const getViva = (client: SupabaseClient, id: string): Promise<VivaDetail> => request(client, `${BASE}/sessions/${id}`, vivaDetailSchema);

/** Starts a viva: the examiner prepares the first question while this request is open (one local AI call). */
export const createViva = (client: SupabaseClient, input: CreateVivaRequest): Promise<VivaDetail> => request(client, `${BASE}/sessions`, vivaDetailSchema, post(input));

/** Submits ONE answer; the examiner evaluates it while this request is open. */
export const answerViva = (client: SupabaseClient, id: string, input: AnswerVivaInput): Promise<VivaDetail> => request(client, `${BASE}/sessions/${id}/answer`, vivaDetailSchema, post(input));

/** Asks for the next question (one local AI call). */
export const nextViva = (client: SupabaseClient, id: string): Promise<VivaDetail> => request(client, `${BASE}/sessions/${id}/next`, vivaDetailSchema, post());

export const abandonViva = (client: SupabaseClient, id: string): Promise<VivaDetail> => request(client, `${BASE}/sessions/${id}/abandon`, vivaDetailSchema, post());
