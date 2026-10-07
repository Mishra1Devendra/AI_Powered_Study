import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteChunk } from "@copilot/shared";
import { ApiError } from "../../lib/api";
import { getNote, getNoteContent, retryProcessing } from "../../lib/notesApi";
import { isBusy } from "./format";

type Outline = Awaited<ReturnType<typeof getNote>>["outline"];

type DocState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound: boolean }
  | { status: "ready"; note: Note; outline: Outline };

const PAGE = 20;
const POLL_MS = 2500;

/**
 * One document: its details + outline, and its text in pages. Text is loaded as a window of
 * chunks `[first, first + chunks.length)` so jumping to a cited passage far into a large document
 * does not require downloading everything before it.
 */
export function useNoteDocument(client: SupabaseClient, noteId: string) {
  const [doc, setDoc] = useState<DocState>({ status: "loading" });
  const [chunks, setChunks] = useState<NoteChunk[]>([]);
  const [first, setFirst] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [total, setTotal] = useState(0);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const epoch = useRef(0);

  const loadContent = useCallback(
    async (cursor: number, mode: "reset" | "append" | "prepend", limit = PAGE) => {
      const mine = epoch.current;
      setContentLoading(true);
      setContentError(null);
      try {
        const page = await getNoteContent(client, noteId, cursor, limit);
        if (epoch.current !== mine) return;
        setTotal(page.total);
        if (mode === "reset") {
          setChunks(page.chunks);
          setFirst(cursor);
          setNextCursor(page.nextCursor);
        } else if (mode === "append") {
          setChunks((prev) => [...prev, ...page.chunks]);
          setNextCursor(page.nextCursor);
        } else {
          setChunks((prev) => [...page.chunks, ...prev]);
          setFirst(cursor);
        }
      } catch (err) {
        if (epoch.current === mine) setContentError(err instanceof Error ? err.message : "Could not load the document text.");
      } finally {
        if (epoch.current === mine) setContentLoading(false);
      }
    },
    [client, noteId],
  );

  const loadDoc = useCallback(
    async (quiet: boolean) => {
      const mine = epoch.current;
      if (!quiet) setDoc({ status: "loading" });
      try {
        const detail = await getNote(client, noteId);
        if (epoch.current !== mine) return;
        setDoc({ status: "ready", note: detail.note, outline: detail.outline });
        // Ready (on first load, or just became ready while polling): fetch the text once.
        if (detail.note.status === "ready") void loadContent(0, "reset");
      } catch (err) {
        if (epoch.current !== mine) return;
        if (quiet) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setDoc({ status: "error", notFound, message: notFound ? "This note doesn't exist or was removed." : err instanceof Error ? err.message : "Could not load this note." });
      }
    },
    [client, noteId, loadContent],
  );

  useEffect(() => {
    epoch.current++;
    setChunks([]);
    setFirst(0);
    setNextCursor(0);
    setTotal(0);
    void loadDoc(false);
    return () => {
      epoch.current++;
    };
  }, [loadDoc]);

  // Poll only while this note is genuinely still being processed.
  const busy = doc.status === "ready" && isBusy(doc.note);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => void loadDoc(true), POLL_MS);
    return () => clearTimeout(t);
  }, [busy, doc, loadDoc]);

  const loadMore = useCallback(() => {
    if (nextCursor !== null && !contentLoading) void loadContent(nextCursor, "append");
  }, [nextCursor, contentLoading, loadContent]);

  const loadEarlier = useCallback(() => {
    if (first > 0 && !contentLoading) {
      const cursor = Math.max(0, first - PAGE);
      void loadContent(cursor, "prepend", first - cursor);
    }
  }, [first, contentLoading, loadContent]);

  /** Makes `chunkIndex` available in the loaded window (fetching it if needed). Resolves true when it is. */
  const ensureLoaded = useCallback(
    async (chunkIndex: number): Promise<boolean> => {
      if (chunkIndex >= first && chunkIndex < first + chunks.length) return true;
      await loadContent(Math.max(0, chunkIndex - 2), "reset");
      return true;
    },
    [first, chunks.length, loadContent],
  );

  const retry = useCallback(async () => {
    const note = await retryProcessing(client, noteId);
    setDoc((d) => (d.status === "ready" ? { ...d, note } : d));
    if (note.status === "ready") {
      // The outline is built from the chunks, so refresh the details too, then fetch the text.
      await loadDoc(true);
    }
  }, [client, noteId, loadDoc]);

  return {
    doc,
    chunks,
    first,
    total,
    hasMore: nextCursor !== null,
    contentLoading,
    contentError,
    reloadDoc: () => loadDoc(false),
    retryContent: () => loadContent(nextCursor ?? first, chunks.length === 0 ? "reset" : "append"),
    loadMore,
    loadEarlier,
    ensureLoaded,
    retry,
  };
}
