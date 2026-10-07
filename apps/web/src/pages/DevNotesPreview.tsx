import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo } from "react";
import { Route, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import { makeBackend, makeNote } from "../dev/fakeNotesBackend";
import NoteWorkspacePage from "./NoteWorkspacePage";
import NotesPage from "./NotesPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

const TEXTBOOK = [
  ["Introduction to Thermodynamics", "Thermodynamics studies how heat, work and energy move through systems. This chapter introduces the vocabulary used throughout the course: system, surroundings, state and process."],
  ["The First Law", "Energy cannot be created or destroyed, only converted. For a closed system, ΔU = Q − W, where Q is heat added and W is work done by the system."],
  ["Entropy", "Entropy (S) measures how many microscopic arrangements correspond to a macroscopic state. For a reversible process ΔS = ∫ δQ/T. The entropy of an isolated system never decreases."],
  ["The Second Law", "Heat flows spontaneously from hot to cold. No cyclic engine can convert heat entirely into work. The Carnot efficiency is η = 1 − Tc/Th."],
  ["Gibbs Free Energy", "G = H − TS. A process at constant temperature and pressure is spontaneous when ΔG < 0."],
];

/**
 * DEV-ONLY visual preview of AI Notes at /dev/notes. Fake in-memory notes backend (no real API,
 * database, storage or AI). Excluded from production builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevNotesPreview() {
  const backend = useMemo(() => {
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const thermo = makeNote(1, { title: "Thermodynamics - lecture notes", originalFilename: "thermo-lectures.pdf", pageCount: 12, chunkCount: TEXTBOOK.length, fileSize: 1_572_864, createdAt: ago(3000), lastActivityAt: ago(45) });
    const cells = makeNote(2, { title: "Cell biology summary", originalFilename: "cells.md", fileType: "md", pageCount: null, chunkCount: 1, fileSize: 18_432, createdAt: ago(8000), lastActivityAt: ago(5000) });
    const busy = makeNote(3, { title: "Organic chemistry reader", originalFilename: "organic.pdf", status: "processing", chunkCount: 0, pageCount: null, fileSize: 4_300_000, createdAt: ago(2) });
    const bad = makeNote(4, { title: "Scanned handout", originalFilename: "scan.pdf", status: "failed", error: "This PDF has no selectable text. It may be a scan; try a text-based PDF.", chunkCount: 0, pageCount: null, fileSize: 900_000, createdAt: ago(600) });
    const b = makeBackend({
      notes: [thermo, busy, bad, cells],
      chunks: {
        [thermo.id]: TEXTBOOK.map(([heading, content], i) => ({ index: i, page: i * 2 + 1, pageEnd: null, heading: heading!, content: content! })),
        [cells.id]: [{ index: 0, page: null, pageEnd: null, heading: "Organelles", content: "## Organelles\n\n- **Mitochondria** produce ATP\n- **Ribosomes** build proteins\n\nThe energy currency is $ATP \\to ADP + P_i$." }],
      },
      mock: true,
      chunkDelayMs: 40,
    });
    b.knobs.autoReply = (q) => ({
      text: `Based on your notes, here is a short answer to “${q.slice(0, 40)}”.\n\n- Entropy never decreases in an isolated system [S1].\n- The Carnot efficiency is $\\eta = 1 - T_c/T_h$ [S2].\n\nNothing in the notes covers this topic further [S9].`,
      sources: [
        { key: "S1", chunkIndex: 2, page: 5, heading: "Entropy" },
        { key: "S2", chunkIndex: 3, page: 7, heading: "The Second Law" },
      ],
    });
    // The first note already has a short conversation, so the citation UI is visible on load.
    const sources = [{ key: "S1", chunkIndex: 2, page: 5, heading: "Entropy" }];
    b.messages[thermo.id] = [
      b.mk(thermo.id, "user", "Summarize this document.", { action: "summarize" }),
      b.mk(thermo.id, "assistant", "**Summary.** Thermodynamics tracks energy flow. The second law says entropy of an isolated system never decreases [S1].", { sources }),
    ];
    b.chunks[busy.id] = [];
    return b;
  }, []);

  const client = useMemo(() => {
    const session = { access_token: "dev-preview", user: { id: USER, email: "preview@example.com" } } as unknown as Session;
    return {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
        signOut: async () => ({ error: null }),
      },
    } as unknown as SupabaseClient;
  }, []);

  // Layout effects run before any child effect, so the fakes are in place before the first request.
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const originalXhr = window.XMLHttpRequest;
    window.fetch = backend.fetchMock as typeof window.fetch;
    window.XMLHttpRequest = backend.FakeXHR as unknown as typeof XMLHttpRequest;
    return () => {
      window.fetch = originalFetch;
      window.XMLHttpRequest = originalXhr;
    };
  }, [backend]);

  return (
    <div className="flex min-h-0 flex-col gap-2 [&:has(#document-scroller)]:h-full">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory notes, no real files, AI or database.
      </div>
      <div className="min-h-0 flex-1">
        <AuthProvider client={client}>
          <Routes>
            <Route index element={<NotesPage basePath="/dev/notes" />} />
            <Route path=":noteId" element={<NoteWorkspacePage basePath="/dev/notes" />} />
          </Routes>
        </AuthProvider>
      </div>
    </div>
  );
}
