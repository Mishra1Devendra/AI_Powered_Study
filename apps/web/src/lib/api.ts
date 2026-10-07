import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { announceAiUse } from "./aiUsageEvents";
import {
  aiUsageSchema,
  dashboardSchema,
  meResponseSchema,
  profileSchema,
  readinessResponseSchema,
  type AiUsage,
  type Dashboard,
  type MeResponse,
  type Profile,
  type ReadinessResponse,
  type UpdateProfileInput,
} from "@copilot/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed JSON error body, when there was one (e.g. { noteId } for a duplicate upload). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Fired when the server says this account's access was paused by an administrator (HTTP 403 access_revoked). */
export const ACCESS_REVOKED_EVENT = "copilot:access-revoked";

export const NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const UNREADABLE_MESSAGE = "We received an unexpected response from the server. Please try again.";

/** Builds an ApiError with a safe message (and the body) from a failed API response. */
export function errorFromBody(status: number, body: unknown): ApiError {
  const parsed = z.object({ message: z.string() }).safeParse(body);
  return new ApiError(
    status,
    parsed.success ? parsed.data.message : "Something went wrong.",
    body && typeof body === "object" ? (body as Record<string, unknown>) : undefined,
  );
}

/** Calls our API with the user's access token. Identity is decided server-side from the token. */
export async function request<T>(
  client: SupabaseClient,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, "Not signed in.");
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ApiError(0, NETWORK_MESSAGE);
  }
  // The server has answered: if this was an AI action, today's allowance has changed (spent, or given back after an error).
  announceAiUse(init.method, path);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 403 && (body as { error?: unknown } | null)?.error === "access_revoked" && typeof window !== "undefined") window.dispatchEvent(new Event(ACCESS_REVOKED_EVENT));
    throw errorFromBody(res.status, body);
  }
  const parsed = schema.safeParse(body);
  // A response the app cannot read must never reach the student as a library message ("Expected string, received...").
  if (!parsed.success) throw new ApiError(502, UNREADABLE_MESSAGE);
  return parsed.data;
}

export const fetchMe = (client: SupabaseClient): Promise<MeResponse> =>
  request(client, "/api/me", meResponseSchema);

export const fetchDashboard = (client: SupabaseClient): Promise<Dashboard> =>
  request(client, "/api/dashboard", dashboardSchema);

export async function updateProfile(client: SupabaseClient, input: UpdateProfileInput): Promise<Profile> {
  const res = await request(client, "/api/me/profile", z.object({ profile: profileSchema }), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return res.profile;
}

/** Public readiness probe (no auth). The 503 "degraded" body is still a valid response. */
/** How much of today's AI allowance is left (administrators: unlimited). Asking costs nothing. */
export const fetchAiUsage = (client: SupabaseClient): Promise<AiUsage> => request(client, "/api/me/ai-usage", aiUsageSchema);

export async function fetchReadiness(signal?: AbortSignal): Promise<ReadinessResponse> {
  const res = await fetch("/api/health/ready", { signal });
  return readinessResponseSchema.parse(await res.json());
}
