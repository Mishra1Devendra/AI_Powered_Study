import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  healthResponseSchema,
  type Conversation,
  type HealthResponse,
  type SendMessageInput,
  type TutorContextInput,
  type TutorMessage,
  type TutorStreamEvent,
} from "@copilot/shared";
import { request } from "./api";
import { streamSse } from "./sse";

const BASE = "/api/tutor/conversations";

export const listConversations = async (client: SupabaseClient): Promise<Conversation[]> =>
  (await request(client, BASE, conversationListResponseSchema)).conversations;

export const getConversation = (client: SupabaseClient, id: string) =>
  request(client, `${BASE}/${id}`, conversationDetailResponseSchema);

export const createConversation = async (client: SupabaseClient, ctx: TutorContextInput = {}): Promise<Conversation> =>
  (await request(client, BASE, conversationResponseSchema, { method: "POST", body: JSON.stringify(ctx) })).conversation;

export const updateConversation = async (
  client: SupabaseClient,
  id: string,
  patch: TutorContextInput & { title?: string },
): Promise<Conversation> =>
  (await request(client, `${BASE}/${id}`, conversationResponseSchema, { method: "PATCH", body: JSON.stringify(patch) })).conversation;

/** Soft delete on the server: the conversation disappears from the student's list. */
export async function deleteConversation(client: SupabaseClient, id: string): Promise<void> {
  // 204 has no body; request() treats an empty body as null, which z.unknown() accepts.
  await request(client, `${BASE}/${id}`, z.unknown(), { method: "DELETE" });
}

/** Public: tells the UI which AI provider the server is configured with (no AI call is made). */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch("/api/health", { signal });
  return healthResponseSchema.parse(await res.json());
}

/** Sends a message (or asks for a fresh reply) and yields the server-sent events as they arrive. */
export function streamTutorReply(
  client: SupabaseClient,
  conversationId: string,
  input: { kind: "send"; message: SendMessageInput } | { kind: "regenerate" },
  signal: AbortSignal,
): AsyncGenerator<TutorStreamEvent, void, void> {
  const path = `${BASE}/${conversationId}/${input.kind === "send" ? "messages" : "regenerate"}`;
  return streamSse(client, path, input.kind === "send" ? input.message : {}, signal);
}

export type { Conversation, TutorMessage };
