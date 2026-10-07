import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";
import { makeBackend, qid } from "../dev/fakeQuizBackend";
import { QuizBaseContext } from "../features/quiz/paths";
import QuizAttemptPage from "./QuizAttemptPage";
import QuizCreatePage from "./QuizCreatePage";
import QuizDetailPage from "./QuizDetailPage";
import QuizHomePage from "./QuizHomePage";
import QuizResultPage from "./QuizResultPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

/**
 * DEV-ONLY visual preview of AI Quiz at /dev/quiz. A fake in-memory quiz server (with the real
 * rules: answer key hidden until submit, grading on the "server") replaces `fetch` while mounted,
 * so nothing touches the real API, database or AI. Excluded from production builds (lazy,
 * DEV-gated import in App.tsx).
 */
export default function DevQuizPreview() {
  const backend = useMemo(
    () =>
      makeBackend({
        notes: [
          { id: qid(8001), title: "Thermodynamics - lecture notes", chunkCount: 24, pageCount: 12 },
          { id: qid(8002), title: "Cell biology summary", chunkCount: 9, pageCount: null },
        ],
        topics: [{ subject: "Physics", topic: "Thermodynamics" }, { subject: "Biology", topic: null }],
        mock: true,
      }),
    [],
  );
  const [seeded, setSeeded] = useState(false);
  /** React StrictMode runs effects twice in development: seed the fixtures only once. */
  const seedStarted = useRef(false);

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

  // Layout effects run before any child effect, so the fake is in place before the first request.
  useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = backend.fetchMock as typeof window.fetch;
    if (!seedStarted.current) {
      seedStarted.current = true;
      void (async () => {
      const done = backend.addReadyQuiz({ title: "Thermodynamics - lecture notes quiz", sourceType: "notes", sourceLabel: "Thermodynamics - lecture notes", subject: null, questionCount: 8, difficulty: "mixed", questionTypes: ["mcq", "true_false"] });
      backend.addReadyQuiz({ title: "Cell biology summary quiz", sourceType: "notes", sourceLabel: "Cell biology summary", subject: null, questionCount: 5, difficulty: "easy" });
      backend.addReadyQuiz({ title: "Physics · Waves quiz", sourceLabel: "Physics · Waves", questionCount: 6, difficulty: "hard", timeLimitMinutes: 20 });
      backend.addReadyQuiz({ title: "Chemistry quiz (could not be created)", status: "failed", error: "The AI only produced 3 usable questions out of 10. Nothing was saved. Please try again, or ask for fewer questions." });
      backend.quizzes[0]!.status = "failed";
      // One quiz mid-creation, as the real server reports it, so the progress steps can be reviewed.
      const making = backend.addReadyQuiz({ title: "Entropy and heat quiz", sourceType: "notes", sourceLabel: "Thermodynamics - lecture notes", subject: null, questionCount: 8, difficulty: "medium" });
      making.status = "generating";
      making.progress = { stage: "checking", batch: 1, accepted: 3, target: 8 };
      // One finished attempt (7/8 correct would be boring: make it a realistic mix) so results and history have real content.
      const key = backend.key(done.id);
      const started = await (await backend.fetchMock(`/api/quiz/${done.id}/start`, { method: "POST" })).json();
      const answers = started.questions.map((q: { id: string }, i: number) => (i === 3 || i === 6 ? null : { questionId: q.id, selected: i === 1 ? (key.get(q.id)!.correctIndex + 1) % key.get(q.id)!.options.length : key.get(q.id)!.correctIndex })).filter(Boolean);
      await backend.fetchMock(`/api/quiz/attempts/${started.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers }) });
      setSeeded(true);
      })();
    }
    return () => {
      window.fetch = original;
    };
  }, [backend]);

  return (
    <div className="space-y-2">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory quizzes, no real AI, notes or database. Reload the page to reset.
      </div>
      {seeded && (
        <AuthProvider client={client}>
          <QuizBaseContext.Provider value={{ quiz: "/dev/quiz", tutor: "/dev/tutor" }}>
            <Routes>
              <Route index element={<QuizHomePage />} />
              <Route path="new" element={<QuizCreatePage />} />
              <Route path="attempt/:attemptId" element={<QuizAttemptPage />} />
              <Route path="attempt/:attemptId/result" element={<QuizResultPage />} />
              <Route path=":quizId" element={<QuizDetailPage />} />
            </Routes>
          </QuizBaseContext.Provider>
        </AuthProvider>
      )}
    </div>
  );
}
