import type { SupabaseClient } from "@supabase/supabase-js";
import { notificationsResponseSchema, searchResponseSchema, type NotificationsResponse, type SearchResponse } from "@copilot/shared";
import { request } from "./api";

/** Global search: the student's own records only. `signal` lets a newer keystroke cancel the older request. */
export const searchEverything = (client: SupabaseClient, q: string, signal?: AbortSignal): Promise<SearchResponse> =>
  request(client, `/api/search?q=${encodeURIComponent(q)}`, searchResponseSchema, signal ? { signal } : {});

export const getNotifications = (client: SupabaseClient): Promise<NotificationsResponse> => request(client, "/api/notifications", notificationsResponseSchema);
