import { eq } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { dashboardSchema, type Dashboard } from "@copilot/shared";
import { buildDashboard } from "../dashboard/build-dashboard.js";
import type { Database } from "../db/client.js";
import { studentProfiles } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";
import type { NotesRepository } from "../notes/repository.js";
import type { PlannerService } from "../planner/service.js";
import type { ProgressService } from "../progress/service.js";
import type { QuizRepository } from "../quiz/repository.js";
import type { TutorRepository } from "../tutor/repository.js";
import type { VivaRepository } from "../viva/repository.js";

interface Deps {
  db: Database;
  authenticate: preHandlerAsyncHookHandler;
  tutorRepo: TutorRepository;
  notesRepo: NotesRepository;
  quizRepo: QuizRepository;
  planner: PlannerService;
  progress: ProgressService;
  /** Optional: lets "continue learning" offer a viva that is still in progress. */
  vivaRepo?: VivaRepository;
}

const RECENT_ACTIVITY_LIMIT = 5;

export async function dashboardRoutes(app: FastifyInstance, { db, authenticate, tutorRepo, notesRepo, quizRepo, planner, progress, vivaRepo }: Deps) {
  app.get("/api/dashboard", { preHandler: authenticate }, async (req, reply): Promise<Dashboard> => {
    const user = req.user!;
    // Identity comes from the verified token; RLS additionally restricts rows to this user.
    const [profile] = await withUser(db, user.id, (tx) =>
      tx
        .select({ displayName: studentProfiles.displayName, timezone: studentProfiles.timezone })
        .from(studentProfiles)
        .where(eq(studentProfiles.id, user.id)),
    );
    if (!profile) return reply.status(404).send({ error: "profile_not_found", message: "Profile not found." });
    const [recentConversations, recentNotes, recentQuizAttempts, studyPlanToday, snapshot, vivas] = await Promise.all([
      tutorRepo.listConversations(user.id, RECENT_ACTIVITY_LIMIT),
      notesRepo.listNotes(user.id, { sort: "activity", limit: RECENT_ACTIVITY_LIMIT }),
      quizRepo.listAttemptHistory(user.id, 10),
      planner.todayForDashboard(user.id),
      // The Progress snapshot is a bonus: if it cannot be read, the rest of the dashboard still loads.
      progress.snapshot(user.id).catch((err) => (req.log.error(err, "progress snapshot failed"), null)),
      // Also a bonus: without it "continue learning" simply has no viva to offer.
      vivaRepo ? vivaRepo.listSessions(user.id, 5).catch((err) => (req.log.error(err, "viva list failed"), [])) : Promise.resolve([]),
    ]);
    const unfinishedVivas = vivas.filter((v) => v.status === "in_progress").map((v) => ({ id: v.id, subject: v.subject, topic: v.topic, questionCount: v.questionCount, answeredCount: v.answeredCount, startedAt: v.startedAt.toISOString() }));
    return dashboardSchema.parse(buildDashboard(profile, { recentConversations, recentNotes, recentQuizAttempts, studyPlanToday, progress: snapshot, unfinishedVivas }));
  });
}
