import { NOTE_LIMITS } from "@copilot/shared";

export const NOTES_BUCKET = "notes";

/** Storage failures. The message is safe to show; `status` is the upstream HTTP status (0 = unreachable). */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/**
 * Original-file storage, as the signed-in student. The student's own access token is forwarded to
 * Supabase Storage, so the bucket's row-level policies (own folder only, private bucket) decide
 * what is allowed. No service-role key is used or needed.
 */
export interface NotesStorage {
  upload(accessToken: string, path: string, bytes: Uint8Array, mime: string): Promise<void>;
  download(accessToken: string, path: string): Promise<Uint8Array>;
}

/** The only shape a storage path may have: <user uuid>/<document uuid>/original.<ext>. Server-generated. */
const SAFE_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/original\.(pdf|txt|md)$/;

export function assertSafeStoragePath(path: string): string {
  if (!SAFE_PATH.test(path)) throw new StorageError("Invalid storage path.", 400);
  return path;
}

/** Builds the canonical path for a document. Nothing here is derived from user-supplied text. */
export function storagePathFor(userId: string, documentId: string, ext: "pdf" | "txt" | "md"): string {
  return assertSafeStoragePath(`${userId}/${documentId}/original.${ext}`);
}

interface Options {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseStorage({ supabaseUrl, anonKey, fetchImpl = fetch, timeoutMs = 30_000 }: Options): NotesStorage {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, apikey: anonKey });

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new StorageError("File storage is unreachable.", 0);
    }
  }

  return {
    async upload(accessToken, path, bytes, mime) {
      assertSafeStoragePath(path);
      const res = await call(`${base}/object/${NOTES_BUCKET}/${path}`, {
        method: "POST",
        // x-upsert false: never overwrite an existing object.
        headers: { ...headers(accessToken), "Content-Type": mime, "x-upsert": "false" },
        body: Buffer.from(bytes) as unknown as RequestInit["body"],
      });
      if (!res.ok) {
        throw new StorageError(
          res.status === 401 || res.status === 403 ? "Not allowed to store this file." : "Could not store the file.",
          res.status,
        );
      }
    },

    async download(accessToken, path) {
      assertSafeStoragePath(path);
      const res = await call(`${base}/object/authenticated/${NOTES_BUCKET}/${path}`, { method: "GET", headers: headers(accessToken) });
      if (!res.ok) {
        throw new StorageError(res.status === 404 ? "The stored file was not found." : "Could not read the stored file.", res.status);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > NOTE_LIMITS.maxFileBytes) throw new StorageError("The stored file is unexpectedly large.", 413);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > NOTE_LIMITS.maxFileBytes) throw new StorageError("The stored file is unexpectedly large.", 413);
      return bytes;
    },
  };
}
