import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import { makePlannerBackend } from "../dev/fakePlannerBackend";
import { addDays } from "../features/planner/dates";
import { PlannerBaseContext } from "../features/planner/paths";
import StudyPlanCreatePage from "./StudyPlanCreatePage";
import StudyPlanDetailPage from "./StudyPlanDetailPage";
import StudyPlanPage from "./StudyPlanPage";

const USER = "00000000-0000-4000-8000-0000000000aa";
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * DEV-ONLY visual preview of the study planner at /dev/study-plan. A fake in-memory planner server
 * replaces `fetch` while mounted, so nothing touches the real API, database or AI. Excluded from
 * production builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevPlannerPreview() {
  const backend = useMemo(
    () =>
      makePlannerBackend({
        today: TODAY,
        mock: false,
        generation: "poll",
        subjects: ["Physics", "Chemistry", "Mathematics"],
        weakTopics: [{ topic: "Chemical bonding", correct: 2, total: 6, percentage: 33 }],
      }),
    [],
  );
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
      // A previous plan, then the active plan that started 9 days ago with some real progress and two missed sessions.
      backend.addActivePlan({ title: "Mid-term revision", examDate: addDays(TODAY, 40), startDate: addDays(TODAY, -20) });
      const active = backend.addActivePlan({ startDate: addDays(TODAY, -9), examDate: addDays(TODAY, 20) });
      const past = backend.sessions.filter((s) => s.planId === active.id && s.date < TODAY);
      past.forEach((s, i) => {
        if (i < past.length - 2) Object.assign(s, i % 5 === 3 ? { status: "skipped" } : { status: "completed", completedAt: new Date().toISOString(), startedAt: new Date().toISOString() });
      });
      setReady(true);
    }
    return () => {
      window.fetch = original;
    };
  }, [backend]);

  return (
    <div className="space-y-2">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory study plans, no real AI or database. Reload the page to reset.
      </div>
      {ready && (
        <AuthProvider client={client}>
          <PlannerBaseContext.Provider value={{ planner: "/dev/study-plan", tutor: "/dev/tutor", quiz: "/dev/quiz" }}>
            <Routes>
              <Route index element={<StudyPlanPage />} />
              <Route path="new" element={<StudyPlanCreatePage />} />
              <Route path=":planId" element={<StudyPlanDetailPage />} />
            </Routes>
          </PlannerBaseContext.Provider>
        </AuthProvider>
      )}
    </div>
  );
}
