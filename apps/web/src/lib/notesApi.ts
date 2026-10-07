import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  messageSchema,
  noteContentResponseSchema,
  noteDetailResponseSchema,
  noteListResponseSchema,
  noteResponseSchema,
  conversationSchema,
  type AssistantInput,
  type Note,
  type NoteListQuery,
  type PasteNoteInput,
  type TutorStreamEvent,
} from "@copilot/shared";
import { ApiError, NETWORK_MESSAGE, errorFromBody, request } from "./api";
import { streamSse } from "./sse";

const BASE = "/api/notes";

export async function listNotes(client: SupabaseClient, query: Partial<NoteListQuery> = {}): Promise<Note[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const qs = params.toString();
  return (await request(client, qs ? `${BASE}?${qs}` : BASE, noteListResponseSchema)).notes;
}

export const getNote = (client: SupabaseClient, id: string) => request(client, `${BASE}/${id}`, noteDetailResponseSchema);

export const getNoteContent = (client: SupabaseClient, id: string, cursor: number, limit = 20) =>
  request(client, `${BASE}/${id}/content?cursor=${cursor}&limit=${limit}`, noteContentResponseSchema);

export async function uploadText(client: SupabaseClient, input: PasteNoteInput): Promise<Note> {
  return (await request(client, `${BASE}/text`, noteResponseSchema, { method: "POST", body: JSON.stringify(input) })).note;
}

export async function retryProcessing(client: SupabaseClient, id: string): Promise<Note> {
  return (await request(client, `${BASE}/${id}/process`, noteResponseSchema, { method: "POST" })).note;
}

/** Soft delete on the server: the note disappears from the library; its data is retained. */
export async function deleteNote(client: SupabaseClient, id: string): Promise<void> {
  await request(client, `${BASE}/${id}`, z.unknown(), { method: "DELETE" });
}

const conversationResponseSchema = z.object({ conversation: conversationSchema.nullable(), messages: z.array(messageSchema) });
export const getNoteConversation = (client: SupabaseClient, id: string) => request(client, `${BASE}/${id}/conversation`, conversationResponseSchema);

/** Asks the document-grounded assistant (or re-asks the last request) and streams the answer. */
export function streamAssistant(
  client: SupabaseClient,
  id: string,
  input: { kind: "ask"; request: AssistantInput } | { kind: "regenerate" },
  signal: AbortSignal,
): AsyncGenerator<TutorStreamEvent, void, void> {
  const path = `${BASE}/${id}/assistant${input.kind === "regenerate" ? "/regenerate" : ""}`;
  return streamSse(client, path, input.kind === "ask" ? input.request : {}, signal);
}

export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number;
  total: number;
}

/**
 * Uploads a file with REAL progress (XMLHttpRequest reports bytes actually sent; `fetch` cannot).
 * The returned promise settles when the server has finished storing AND processing the file, so
 * once `loaded === total` the UI should show an indeterminate "Processing" state.
 */
export async function uploadFile(
  client: SupabaseClient,
  file: File,
  opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<Note> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, "Your session has expired. Please sign in again.");

  const form = new FormData();
  form.append("file", file, file.name);

  return new Promise<Note>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", BASE);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = noteResponseSchema.safeParse(body);
        if (parsed.success) return resolve(parsed.data.note);
        return reject(new ApiError(502, "The server sent an unreadable response. Please try again."));
      }
      reject(errorFromBody(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(0, NETWORK_MESSAGE));
    xhr.ontimeout = () => reject(new ApiError(0, NETWORK_MESSAGE));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (opts.signal?.aborted) return xhr.abort();
    xhr.send(form);
  });
}
