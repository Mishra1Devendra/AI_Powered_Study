import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo, useState } from "react";
import { AuthProvider } from "../auth/AuthProvider";
import { emptyRecommendations, makeRecommendationsBackend, planOnly, richRecommendations } from "../dev/fakeRecommendationsBackend";
import { RecoBaseContext } from "../features/recommendations/paths";
import RecommendationsPage from "./RecommendationsPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

/**
 * DEV-ONLY visual preview of Smart Revision at /dev/recommendations (add ?empty=1 for a brand-new student, ?plan=1 for
 * a student with only a study plan). A fake in-memory server replaces `fetch` while mounted, so nothing touches the real
 * API, database or AI. Excluded from production builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevRecommendationsPreview() {
  const q = new URLSearchParams(window.location.search);
  const backend = useMemo(() => makeRecommendationsBackend(q.has("empty") ? emptyRecommendations() : q.has("plan") ? planOnly() : richRecommendations()), []);
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
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory recommendations, no real student, AI or database. Add <code>?empty=1</code> or <code>?plan=1</code> for other states.
      </div>
      {ready && (
        <AuthProvider client={client}>
          <RecoBaseContext.Provider value={{ quiz: "/dev/quiz", viva: "/dev/viva", tutor: "/dev/tutor", notes: "/dev/notes", studyPlan: "/dev/study-plan", recommendations: "/dev/recommendations" }}>
            <RecommendationsPage />
          </RecoBaseContext.Provider>
        </AuthProvider>
      )}
    </div>
  );
}
