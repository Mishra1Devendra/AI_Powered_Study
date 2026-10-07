import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ProtectedRoute, PublicOnlyRoute } from "./auth/RouteGuards";
import { AppShell } from "./components/layout/AppShell";
import { AccessGate } from "./features/access/AccessGate";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import NotFoundPage from "./pages/NotFoundPage";
import SignupPage from "./pages/SignupPage";
import { FullPageSpinner } from "./components/ui/Spinner";

// Screens load on demand, so signing in only downloads the dashboard and what the student actually opens.
const AdminPage = lazy(() => import("./pages/AdminPage"));
const AdminAiStatusPage = lazy(() => import("./pages/AdminAiStatusPage"));
const AdminBugReportsPage = lazy(() => import("./pages/AdminBugReportsPage"));
const AdminAuditLogPage = lazy(() => import("./pages/AdminAuditLogPage"));
const DeckPage = lazy(() => import("./pages/DeckPage"));
const FlashcardsPage = lazy(() => import("./pages/FlashcardsPage"));
const MindmapPage = lazy(() => import("./pages/MindmapPage"));
const MindmapsPage = lazy(() => import("./pages/MindmapsPage"));
const StudyPage = lazy(() => import("./pages/StudyPage"));
const NotesPage = lazy(() => import("./pages/NotesPage"));
const NoteWorkspacePage = lazy(() => import("./pages/NoteWorkspacePage"));
const ProgressPage = lazy(() => import("./pages/ProgressPage"));
const RecommendationsPage = lazy(() => import("./pages/RecommendationsPage"));
const QuizAttemptPage = lazy(() => import("./pages/QuizAttemptPage"));
const QuizCreatePage = lazy(() => import("./pages/QuizCreatePage"));
const QuizDetailPage = lazy(() => import("./pages/QuizDetailPage"));
const QuizHomePage = lazy(() => import("./pages/QuizHomePage"));
const QuizResultPage = lazy(() => import("./pages/QuizResultPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const StudyPlanCreatePage = lazy(() => import("./pages/StudyPlanCreatePage"));
const StudyPlanDetailPage = lazy(() => import("./pages/StudyPlanDetailPage"));
const StudyPlanPage = lazy(() => import("./pages/StudyPlanPage"));
const StatusPage = lazy(() => import("./pages/StatusPage"));
const TutorPage = lazy(() => import("./pages/TutorPage"));
const VivaPage = lazy(() => import("./pages/VivaPage"));
const VivaSessionPage = lazy(() => import("./pages/VivaSessionPage"));

// DEV-only preview. The dynamic import sits behind a build-time constant, so production builds
// never emit this chunk (or its sample data).
const DevDashboardPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevDashboardPreview")) : null;
const DevTutorPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevTutorPreview")) : null;
const DevNotesPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevNotesPreview")) : null;
const DevQuizPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevQuizPreview")) : null;
const DevPlannerPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevPlannerPreview")) : null;
const DevProgressPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevProgressPreview")) : null;
const DevVivaPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevVivaPreview")) : null;
const DevRecommendationsPreview = import.meta.env.DEV ? lazy(() => import("./pages/DevRecommendationsPreview")) : null;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/status" element={<StatusPage />} />

      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Route>

      {/* Everything inside requires a signed-in user (enforced again by the API + RLS). */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AccessGate />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/tutor/:conversationId?" element={<TutorPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/notes/:noteId" element={<NoteWorkspacePage />} />
          <Route path="/quiz" element={<QuizHomePage />} />
          <Route path="/quiz/new" element={<QuizCreatePage />} />
          <Route path="/quiz/attempt/:attemptId" element={<QuizAttemptPage />} />
          <Route path="/quiz/attempt/:attemptId/result" element={<QuizResultPage />} />
          <Route path="/quiz/:quizId" element={<QuizDetailPage />} />
          <Route path="/flashcards" element={<FlashcardsPage />} />
          <Route path="/flashcards/:deckId" element={<DeckPage />} />
          <Route path="/flashcards/:deckId/study" element={<StudyPage />} />
          <Route path="/mindmaps" element={<MindmapsPage />} />
          <Route path="/mindmaps/:id" element={<MindmapPage />} />
          <Route path="/study-plan" element={<StudyPlanPage />} />
          <Route path="/study-plan/new" element={<StudyPlanCreatePage />} />
          <Route path="/study-plan/:planId" element={<StudyPlanDetailPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/recommendations" element={<RecommendationsPage />} />
          <Route path="/viva" element={<VivaPage />} />
          <Route path="/viva/:id" element={<VivaSessionPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/ai" element={<AdminAiStatusPage />} />
          <Route path="/admin/bug-reports" element={<AdminBugReportsPage />} />
          <Route path="/admin/audit-log" element={<AdminAuditLogPage />} />
        </Route>
        </Route>
      </Route>

      {/* DEV only: fixture-based design preview, no data access. Excluded from production builds. */}
      {DevDashboardPreview && DevTutorPreview && DevNotesPreview && DevQuizPreview && DevPlannerPreview && DevProgressPreview && DevVivaPreview && DevRecommendationsPreview && (
        <Route element={<AccessGate />}>
        <Route element={<AppShell />}>
          <Route
            path="/dev/recommendations"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevRecommendationsPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/viva/*"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevVivaPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/progress"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevProgressPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/study-plan/*"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevPlannerPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/quiz/*"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevQuizPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/notes/*"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevNotesPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/tutor/:conversationId?"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevTutorPreview />
              </Suspense>
            }
          />
          <Route
            path="/dev/dashboard"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading preview" />}>
                <DevDashboardPreview />
              </Suspense>
            }
          />
        </Route>
        </Route>
      )}

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
