import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteFileType, NoteListQuery, NoteStatus } from "@copilot/shared";
import { deleteNote, listNotes, retryProcessing } from "../../lib/notesApi";
import { isBusy } from "./format";

export interface LibraryFilters {
  q: string;
  type: NoteFileType | "";
  status: NoteStatus | "";
  sort: NoteListQuery["sort"];
}

export const DEFAULT_FILTERS: LibraryFilters = { q: "", type: "", status: "", sort: "recent" };

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; notes: Note[] };

const POLL_MS = 2500;

/** The student's notes library. Re-fetches only when filters change, or while a note is still being processed. */
export function useNotesLibrary(client: SupabaseClient, filters: LibraryFilters) {
  const [state, setState] = useState<State>({ status: "loading" });
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) setState({ status: "loading" });
      try {
        const notes = await listNotes(client, {
          ...(filters.q ? { q: filters.q } : {}),
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          sort: filters.sort,
        });
        if (seq.current === mine) setState({ status: "ready", notes });
      } catch (err) {
        if (seq.current !== mine) return;
        // A failed background refresh keeps showing what we already have.
        setState((s) => (quiet && s.status === "ready" ? s : { status: "error", message: err instanceof Error ? err.message : "Could not load your notes." }));
      }
    },
    [client, filters.q, filters.type, filters.status, filters.sort],
  );

  useEffect(() => {
    void load();
    return () => {
      seq.current++; // ignore anything still in flight
    };
  }, [load]);

  // Poll our own API only while some note is genuinely still uploading/processing.
  const anyBusy = state.status === "ready" && state.notes.some(isBusy);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setTimeout(() => void load(true), POLL_MS);
    return () => clearTimeout(timer);
  }, [anyBusy, state, load]);

  /** Put a note (just uploaded, retried...) into the list without refetching. */
  const upsert = useCallback((note: Note) => {
    setState((s) => (s.status === "ready" ? { status: "ready", notes: [note, ...s.notes.filter((n) => n.id !== note.id)] } : s));
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteNote(client, id);
      setState((s) => (s.status === "ready" ? { status: "ready", notes: s.notes.filter((n) => n.id !== id) } : s));
    },
    [client],
  );

  const retry = useCallback(
    async (id: string) => {
      const note = await retryProcessing(client, id);
      setState((s) => (s.status === "ready" ? { status: "ready", notes: s.notes.map((n) => (n.id === id ? note : n)) } : s));
    },
    [client],
  );

  return { state, reload: () => load(), upsert, remove, retry };
}

/** Delays a fast-changing value (the search box) so we do not query on every keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
