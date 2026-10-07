import type { SupabaseClient } from "@supabase/supabase-js";
import { progressResponseSchema, type ProgressRange, type ProgressResponse } from "@copilot/shared";
import { request } from "./api";

/** One read-only request. The server works out everything; the identity comes from the sign-in token only. */
export const getProgress = (client: SupabaseClient, range: ProgressRange): Promise<ProgressResponse> =>
  request(client, `/api/progress/summary?range=${range}`, progressResponseSchema);
