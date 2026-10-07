import type { SupabaseClient } from "@supabase/supabase-js";
import type { VivaDetail, VivaListResponse, VivaOptions } from "@copilot/shared";
import { getViva, getVivaOptions, listVivas } from "../../lib/vivaApi";
import { useLoad } from "../quiz/useQuizData";

/** Plain loads, no polling: a viva only changes when the student acts. */
export const useVivaList = (client: SupabaseClient) => useLoad<VivaListResponse>(() => listVivas(client), [client]);
export const useVivaOptions = (client: SupabaseClient) => useLoad<VivaOptions>(() => getVivaOptions(client), [client]);
export function useVivaDetail(client: SupabaseClient, id: string) {
  const result = useLoad<VivaDetail>(() => getViva(client, id), [client, id]);
  const notFound = result.state.status === "error" && /not found/i.test(result.state.message);
  return { ...result, notFound };
}
