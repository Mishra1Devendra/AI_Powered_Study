import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo, useState } from "react";
import { AuthProvider } from "../auth/AuthProvider";
import { emptyProgress, makeProgressBackend, richProgress } from "../dev/fakeProgressBackend";
import { ProgressBaseContext } from "../features/progress/paths";
import ProgressPage from "./ProgressPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

/**
 * DEV-ONLY visual preview of Progress at /dev/progress (add ?empty=1 for a brand-new student). A fake in-memory
 * server replaces `fetch` while mounted, so nothing touches the real API or database. Excluded from production
 * builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevProgressPreview() {
  const empty = new URLSearchParams(window.location.search).has("empty");
  const backend = useMemo(() => makeProgressBackend((r) => (empty ? emptyProgress(r) : richProgress(r))), [empty]);
  const [ready, setReady] = useState(false);
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
    setReady(true);
    return () => {
      window.fetch = original;
    };
  }, [backend]);

  return (
    <div className="space-y-2">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory progress numbers, no real student, API or database. Add <code>?empty=1</code> to the address to see a brand-new student.
      </div>
      {ready && (
        <AuthProvider client={client}>
          <ProgressBaseContext.Provider value={{ quiz: "/dev/quiz", tutor: "/dev/tutor", studyPlan: "/dev/study-plan" }}>
            <ProgressPage />
          </ProgressBaseContext.Provider>
        </AuthProvider>
      )}
    </div>
  );
}
