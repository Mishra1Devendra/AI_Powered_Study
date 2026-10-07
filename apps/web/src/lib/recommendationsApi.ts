import type { SupabaseClient } from "@supabase/supabase-js";
import { explainResponseSchema, recommendationsResponseSchema, type ExplainResponse, type RecommendationsResponse } from "@copilot/shared";
import { request } from "./api";

/** Read-only and deterministic: the server works everything out from the student's own records, with no AI. */
export const getRecommendations = (client: SupabaseClient, limit?: number): Promise<RecommendationsResponse> =>
  request(client, `/api/recommendations${limit ? `?limit=${limit}` : ""}`, recommendationsResponseSchema);

/** The OPTIONAL friendly wording: one local-AI call, only when the student asks. It takes no input - the server recomputes the facts. */
export const explainRecommendations = (client: SupabaseClient): Promise<ExplainResponse> =>
  request(client, "/api/recommendations/explain", explainResponseSchema, { method: "POST", body: "{}" });
