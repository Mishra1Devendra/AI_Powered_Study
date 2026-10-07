import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import { makeVivaBackend } from "../dev/fakeVivaBackend";
import { VivaBaseContext } from "../features/viva/paths";
import VivaPage from "./VivaPage";
import VivaSessionPage from "./VivaSessionPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

/**
 * DEV-ONLY visual preview of AI Viva at /dev/viva (add ?mock=1 for the offline demo labelling). A fake in-memory
 * server replaces `fetch` while mounted, so nothing touches the real API, database or AI. Excluded from production
 * builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevVivaPreview() {
  const mock = new URLSearchParams(window.location.search).has("mock");
  const backend = useMemo(() => makeVivaBackend({ mock, topics: [{ subject: "Chemistry", topic: "Reaction rates" }, { subject: "Physics", topic: "Thermodynamics" }], documents: [{ id: "00000000-0000-4000-8000-0000000000d1", title: "Thermodynamics - lecture notes", chunkCount: 12 }, { id: "00000000-0000-4000-8000-0000000000d2", title: "Cell biology summary", chunkCount: 4 }] }), [mock]);
  const [ready, setReady] = useState(false);
  const seeded = useRef(false);

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

  useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = backend.fetchMock as typeof window.fetch;
    if (!seeded.current) {
      seeded.current = true;
      backend.addCompleted({ subject: "Physics", topic: "Thermodynamics", difficulty: "medium", scores: [82, 64, 91, 70, 78] });
      backend.addCompleted({ subject: "Chemistry", topic: "Reaction rates", difficulty: "hard", scores: [48, 35, 60, 42, 55] });
      setReady(true);
    }
    return () => {
      window.fetch = original;
    };
  }, [backend]);

  return (
    <div className="space-y-2">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory vivas, no real AI or database. Add <code>?mock=1</code> for the offline-demo labelling. Reload to reset.
      </div>
      {ready && (
        <AuthProvider client={client}>
          <VivaBaseContext.Provider value={{ viva: "/dev/viva", tutor: "/dev/tutor" }}>
            <Routes>
              <Route index element={<VivaPage />} />
              <Route path=":id" element={<VivaSessionPage />} />
            </Routes>
          </VivaBaseContext.Provider>
        </AuthProvider>
      )}
    </div>
  );
}
