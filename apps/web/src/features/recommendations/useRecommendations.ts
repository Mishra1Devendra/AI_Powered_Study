import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecommendationsResponse } from "@copilot/shared";
import { getRecommendations } from "../../lib/recommendationsApi";
import { useLoad } from "../quiz/useQuizData";

/** A plain load, no polling: recommendations only change when the student's learning data does. */
export const useRecommendations = (client: SupabaseClient, limit?: number) => useLoad<RecommendationsResponse>(() => getRecommendations(client, limit), [client, limit]);
