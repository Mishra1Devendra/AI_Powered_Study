import type { SupabaseClient } from "@supabase/supabase-js";
import { tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { announceAiUse } from "./aiUsageEvents";
import { ApiError, NETWORK_MESSAGE, errorFromBody } from "./api";

/**
 * POSTs JSON and yields the server-sent events of a streamed reply. The AI Tutor and the AI Notes
 * assistant share this protocol. Throws ApiError for HTTP failures that happen before streaming
 * starts (401, 404, 409, 429...) and ApiError(0) for network failures. Aborting `signal` ends the
 * stream quietly.
 */
export async function* streamSse(
  client: SupabaseClient,
  path: string,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<TutorStreamEvent, void, void> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, "Your session has expired. Please sign in again.");

  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, NETWORK_MESSAGE);
  }

  // The charge is made before the reply starts streaming, so the allowance has already changed.
  announceAiUse("POST", path);
  if (!res.ok || !res.body) throw errorFromBody(res.status, await res.json().catch(() => null));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (!frame.startsWith("data: ")) continue;
        let event: TutorStreamEvent;
        try {
          event = tutorStreamEventSchema.parse(JSON.parse(frame.slice(6)));
        } catch {
          throw new ApiError(502, "The assistant sent an unreadable response. Please try again.");
        }
        yield event;
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, NETWORK_MESSAGE);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
