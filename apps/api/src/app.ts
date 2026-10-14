import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { HealthResponse, ReadinessResponse } from "@copilot/shared";
import { createAccessRepository, type AccessRepository } from "./access/repository.js";
import { installAiQuota } from "./ai-quota/guard.js";
import { createAiUsageRepository, type AiUsageRepository } from "./ai-quota/repository.js";
import { createAiQuota } from "./ai-quota/service.js";
import { createAuthenticate, requireAdmin } from "./auth/plugin.js";
import { createBugRepository, type BugRepository } from "./bugs/repository.js";
import type { TokenVerifier } from "./auth/verify-token.js";
import type { Env } from "./config/env.js";
import { pingDb, type Database } from "./db/client.js";
import { AppError } from "./errors.js";
import { buildLoggerOptions } from "./logging.js";
import { createKnowledgeRepository, type KnowledgeRepository } from "./knowledge/repository.js";
import { createKnowledgeService } from "./knowledge/service.js";
import { createNotesRepository, type NotesRepository } from "./notes/repository.js";
import { createNotesService } from "./notes/service.js";
import { StorageError, createSupabaseStorage, type NotesStorage } from "./notes/storage.js";
import { createCheckRepository, type CheckRepository } from "./planner/checks/repository.js";
import { createCheckService, type CheckService } from "./planner/checks/service.js";
import { createPlannerRepository, type PlannerRepository } from "./planner/repository.js";
import { createPlannerService, type PlannerService } from "./planner/service.js";
import { createProgressRepository, type ProgressRepository } from "./progress/repository.js";
import { createProgressService, type ProgressService } from "./progress/service.js";
import { createNotificationService } from "./notifications/service.js";
import { createSearchRepository, type SearchRepository } from "./search/repository.js";
import { createVivaRepository, type VivaRepository } from "./viva/repository.js";
import { createVivaService, type VivaService } from "./viva/service.js";
import { createExtrasRepository, type ExtrasRepository } from "./recommendations/repository.js";
import { createRecommendationService, type RecommendationService } from "./recommendations/service.js";
import { createQuizRepository, type QuizRepository } from "./quiz/repository.js";
import { createQuizService, type QuizService } from "./quiz/service.js";
import { adminRoutes } from "./routes/admin.js";
import { bugRoutes } from "./routes/bugs.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { meRoutes } from "./routes/me.js";
import { notificationRoutes } from "./routes/notifications.js";
import { searchRoutes } from "./routes/search.js";
import { notesRoutes } from "./routes/notes.js";
import { plannerRoutes } from "./routes/planner.js";
import { progressRoutes } from "./routes/progress.js";
import { quizRoutes } from "./routes/quiz.js";
import { recommendationRoutes } from "./routes/recommendations.js";
import { studyToolsRoutes } from "./routes/study-tools.js";
import { createStudyToolsRepository, type StudyToolsRepository } from "./study-tools/repository.js";
import { createStudyToolsService, type StudyToolsService } from "./study-tools/service.js";
import { tutorRoutes } from "./routes/tutor.js";
import { vivaRoutes } from "./routes/viva.js";
import { AIError, type LLMProvider } from "./services/ai/index.js";
import { createTutorRepository, type TutorRepository } from "./tutor/repository.js";
import { createTutorService } from "./tutor/service.js";

export interface AppDeps {
  env: Env;
  db: Database;
  ai: LLMProvider;
  verifyToken: TokenVerifier;
  /** Test seam: swap the persistence layer (defaults to the Drizzle/Supabase repository). */
  tutorRepo?: TutorRepository;
  /** Overall limit for one AI reply (local models can be slow on CPU). */
  replyDeadlineMs?: number;
  /** Test seams for AI Notes persistence and file storage. */
  notesRepo?: NotesRepository;
  notesStorage?: NotesStorage;
  /**
   * Test seam for knowledge grounding (search over the student's documents). When a test injects its own in-memory
   * notes store but no matching knowledge repository, grounding is simply off - the Tutor and Notes behave as before.
   */
  knowledgeRepo?: KnowledgeRepository;
  /** Test seam for AI Quiz persistence (defaults to the Drizzle/Supabase repository). */
  quizRepo?: QuizRepository;
  /** Test seams: clock and randomness for the quiz service. */
  quizNow?: () => Date;
  quizRng?: () => number;
  /** Test seams for the study planner (persistence and clock). */
  plannerRepo?: PlannerRepository;
  plannerNow?: () => Date;
  /** Test seams for Progress (persistence and clock). */
  progressRepo?: ProgressRepository;
  progressNow?: () => Date;
  /** Test seams for AI Viva (persistence and the per-step deadline). */
  vivaRepo?: VivaRepository;
  /** Test seam for global search (defaults to the Drizzle/Supabase repository). */
  searchRepo?: SearchRepository;
  vivaStepDeadlineMs?: number;
  /** Test seams for Smart Revision (the extra facts, and the deadline of the optional AI wording). */
  extrasRepo?: ExtrasRepository;
  explainDeadlineMs?: number;
  /**
   * Who is an admin / whose access is paused. Defaults to the database in every environment except NODE_ENV=test, where the
   * (many) route tests use stubbed databases and skip the check unless they inject this seam. Covered by access tests.
   */
  accessRepo?: AccessRepository;
  /** Bug reports (same rule as accessRepo: real database except in NODE_ENV=test unless injected). */
  bugRepo?: BugRepository;
  /**
   * Study checks (answer 5 questions before a session can be completed). Same rule as accessRepo: the real database everywhere
   * except NODE_ENV=test, where it is off unless a test injects it (so the older planner tests that complete sessions directly still run).
   */
  checkRepo?: CheckRepository;
  /** Test seam: the clock and randomness of the study-check service. */
  checkNow?: () => Date;
  /** Flashcards and mind maps (same rule as bugRepo: real database except in NODE_ENV=test unless injected). */
  studyToolsRepo?: StudyToolsRepository;
  /** Test seams: the clock of the flashcard scheduler, and the time limit of a writing job. */
  studyNow?: () => Date;
  studyJobDeadlineMs?: number;
  /** The daily AI allowance counters (same rule as bugRepo: real database except in NODE_ENV=test unless injected). Administrators are never limited. */
  aiUsageRepo?: AiUsageRepository;
  /** Test seam: the clock of the daily AI allowance. */
  aiQuotaNow?: () => Date;
}

/** The access repository the app uses: injected, else the real database (not in NODE_ENV=test). */
export function resolveAccessRepo(env: Pick<Env, "NODE_ENV">, db: Database, injected?: AccessRepository): AccessRepository | undefined {
  return injected ?? (env.NODE_ENV === "test" ? undefined : createAccessRepository(db));
}

/** The quiz service of the most recently built app (tests use it to wait for background generation). */
export interface BuiltApp extends FastifyInstance {
  quiz: QuizService;
  planner: PlannerService;
  progress: ProgressService;
  viva: VivaService;
  recommendations: RecommendationService;
  /** Undefined when study checks are off (NODE_ENV=test without an injected repository). */
  checks: CheckService | undefined;
  /** Undefined when flashcards and mind maps are off (NODE_ENV=test without an injected repository). */
  studyTools: StudyToolsService | undefined;
}

export async function buildApp({ env, db, ai, verifyToken, tutorRepo, replyDeadlineMs, notesRepo, notesStorage, quizRepo, quizNow, quizRng, plannerRepo, plannerNow, progressRepo, progressNow, vivaRepo, vivaStepDeadlineMs, extrasRepo, explainDeadlineMs, knowledgeRepo, searchRepo, accessRepo, bugRepo, checkRepo, checkNow, studyToolsRepo, studyNow, studyJobDeadlineMs, aiUsageRepo, aiQuotaNow }: AppDeps): Promise<BuiltApp> {
  const app = Fastify({
    logger: buildLoggerOptions(env.NODE_ENV),
    bodyLimit: 1_048_576,
    // Behind a reverse proxy the client address comes from X-Forwarded-For; without this every student shares the proxy's address and its rate limit.
    // Off by default: a directly exposed server must not believe a header the client can forge.
    trustProxy: env.TRUST_PROXY,
  });

  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.decorateRequest("user", null);
  app.decorateRequest("accessToken", null);
  app.decorateRequest("role", null);
  // The daily AI allowance: every route that asks the AI for something is guarded (app.aiQuota.guard), administrators are never limited.
  const usageRepo = aiUsageRepo ?? (env.NODE_ENV === "test" ? undefined : createAiUsageRepository(db));
  installAiQuota(app, usageRepo ? createAiQuota({ repo: usageRepo, dailyUnits: env.AI_DAILY_UNITS, ...(aiQuotaNow ? { now: aiQuotaNow } : {}) }) : undefined);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "invalid_input",
        message: err.issues[0]?.message ?? "Invalid input.",
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.extra ?? {}) });
    }
    if (err instanceof AIError) {
      return reply.status(err.code === "rate_limited" ? 429 : 502).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    return reply.status(status).send({
      error: status === 500 ? "internal_error" : "request_error",
      message:
        status === 500
          ? "Something went wrong."
          : status === 429
            ? "Too many requests. Please slow down and try again shortly."
            : status === 413
              ? "That request is too large."
              : err.message,
    });
  });

  // Public and unauthenticated: only the generic label. The chain's real model name belongs on the admin AI-status page, not to anyone who can reach the URL.
  const aiStatus = { provider: ai.name, isMock: ai.isMock, model: ai.name === "free-ai" ? "free-ai" : ai.model };

  app.get("/api/health", async (): Promise<HealthResponse> => ({ status: "ok", ai: aiStatus }));

  app.get("/api/health/ready", async (_req, reply): Promise<ReadinessResponse> => {
    // Public monitor endpoint: "is the database answering", nothing more. No timings, no driver text, and no call to the AI server
    // (an anonymous caller must not be able to make this server call another one). AI reachability is on the admin AI-status page.
    const database = await pingDb(db);
    if (!database.ok) reply.status(503);
    return {
      status: database.ok ? "ok" : "degraded",
      database: { ok: database.ok, latencyMs: null, error: database.ok ? null : "Database unreachable" },
      ai: { ...aiStatus, reachable: null, modelInstalled: null },
    };
  });

  const access = resolveAccessRepo(env, db, accessRepo);
  const authenticate = createAuthenticate(verifyToken, access);
  const repo = tutorRepo ?? createTutorRepository(db);
  const knowledge = knowledgeRepo ? createKnowledgeService({ repo: knowledgeRepo }) : notesRepo ? undefined : createKnowledgeService({ repo: createKnowledgeRepository(db) });
  const tutor = createTutorService({
    repo,
    ai,
    knowledge,
    ...(replyDeadlineMs ? { replyDeadlineMs } : {}),
    onError: (err) => app.log.error(err, "tutor generation failed"),
  });

  // File storage acts as the signed-in student (their own token + the public anon key). If the
  // anon key is not configured, uploads fail with a clear message instead of the server failing to start.
  const storage: NotesStorage =
    notesStorage ??
    (env.SUPABASE_ANON_KEY
      ? createSupabaseStorage({ supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY })
      : {
          upload: async () => {
            throw new StorageError("File storage is not configured.", 0);
          },
          download: async () => {
            throw new StorageError("File storage is not configured.", 0);
          },
        });
  const notesRepository = notesRepo ?? createNotesRepository(db);
  const notes = createNotesService({
    repo: notesRepository,
    tutorRepo: repo,
    storage,
    ai,
    knowledge,
    ...(replyDeadlineMs ? { replyDeadlineMs } : {}),
    onError: (err) => app.log.error(err, "notes operation failed"),
  });

  const quizRepository = quizRepo ?? createQuizRepository(db);
  const quiz = createQuizService({
    repo: quizRepository,
    notes: notesRepository,
    ai,
    ...(quizNow ? { now: quizNow } : {}),
    ...(quizRng ? { rng: quizRng } : {}),
    onError: (err) => app.log.error(err, "quiz generation failed"),
  });

  const checkRepository = checkRepo ?? (env.NODE_ENV === "test" ? undefined : createCheckRepository(db));
  const planner = createPlannerService({
    repo: plannerRepo ?? createPlannerRepository(db),
    ...(checkRepository ? { checkGate: (userId: string, sessionId: string) => checkRepository.hasPassed(userId, sessionId) } : {}),
    ai,
    // Real per-topic quiz accuracy picks the weak topics to schedule early (no extra AI call).
quizTopics: async (userId) =>
  (await quizRepository.summary(userId)).topics
    .filter(
      (topic): topic is typeof topic & { topic: string } =>
        typeof topic.topic === "string",
    )
    .map((topic) => ({
      topic: topic.topic,
      correct: topic.correct,
      total: topic.total,
      percentage: topic.percentage,
    })),
    ...(plannerNow ? { now: plannerNow } : {}),
    onError: (err) => app.log.error(err, "study plan generation failed"),
  });

  const progressRepository = progressRepo ?? createProgressRepository(db);
  const progress = createProgressService({ repo: progressRepository, ...(progressNow ? { now: progressNow } : {}) });

  const vivaRepository = vivaRepo ?? createVivaRepository(db);
  const viva = createVivaService({
    repo: vivaRepository,
    ai,
    knowledge,
    // Suggestions only: subjects and topics the student already used (no AI).
    topics: (userId) => quizRepository.topicSuggestions(userId, 12),
    ...(vivaStepDeadlineMs ? { stepDeadlineMs: vivaStepDeadlineMs } : {}),
    onError: (err) => app.log.error(err, "viva operation failed"),
  });

  const recommendations = createRecommendationService({
    progress: progressRepository,
    extras: extrasRepo ?? createExtrasRepository(db),
    ai,
    knowledge,
    ...(progressNow ? { now: progressNow } : {}),
    ...(explainDeadlineMs ? { explainDeadlineMs } : {}),
    onError: (err) => app.log.error(err, "recommendations explanation failed"),
  });

  // In-app notifications: derived on request from the student's own records (no AI, nothing stored or scheduled).
  const notifications = createNotificationService(
    {
      openSessions: (userId) => planner.openSessions(userId),
      quizAttempts: (userId) => quizRepository.listAttemptHistory(userId, 5),
      vivas: async (userId) => (await vivaRepository.listSessions(userId, 5)).map((v) => ({ id: v.id, subject: v.subject, topic: v.topic, status: v.status, score: v.score, completedAt: v.completedAt })),
      topRecommendation: async (userId) => (await recommendations.list(userId, 1)).recommendations[0] ?? null,
    },
    { ...(progressNow ? { now: progressNow } : {}), onError: (err) => app.log.error(err, "notifications source failed") },
  );

  await app.register(meRoutes, { db, authenticate });
  // Admin routes exist only when an access repository is configured; without one nobody can be proven to be an admin.
  const bugs = bugRepo ?? (env.NODE_ENV === "test" ? undefined : createBugRepository(db));
  if (access) await app.register(adminRoutes, { repo: access, bugs, ai, authenticate, requireAdmin });
  if (bugs) await app.register(bugRoutes, { repo: bugs, authenticate });
  await app.register(dashboardRoutes, { db, authenticate, tutorRepo: repo, notesRepo: notesRepository, quizRepo: quizRepository, planner, progress, vivaRepo: vivaRepository });
  await app.register(searchRoutes, { repo: searchRepo ?? createSearchRepository(db), authenticate });
  await app.register(notificationRoutes, { service: notifications, authenticate });
  await app.register(tutorRoutes, { service: tutor, authenticate });
  await app.register(notesRoutes, { service: notes, authenticate });
  await app.register(quizRoutes, { service: quiz, authenticate });
  const checks = checkRepository ? createCheckService({ repo: checkRepository, planner, notes: notesRepository, ai, ...(checkNow ? { now: checkNow } : {}), onError: (err) => app.log.error(err, "study check generation failed") }) : undefined;
  await app.register(plannerRoutes, { service: planner, checks, authenticate });
  await app.register(progressRoutes, { service: progress, authenticate });
  await app.register(vivaRoutes, { service: viva, authenticate });
  await app.register(recommendationRoutes, { service: recommendations, authenticate });
  const studyRepo = studyToolsRepo ?? (env.NODE_ENV === "test" ? undefined : createStudyToolsRepository(db));
  const studyTools = studyRepo
    ? createStudyToolsService({
        repo: studyRepo,
        notes: notesRepository,
        ai,
        ...(studyNow ? { now: studyNow } : {}),
        ...(studyJobDeadlineMs ? { jobDeadlineMs: studyJobDeadlineMs } : {}),
        onError: (err) => app.log.error(err, "flashcards / mind map generation failed"),
      })
    : undefined;
  if (studyTools) await app.register(studyToolsRoutes, { service: studyTools, authenticate });

  const built = app as unknown as BuiltApp;
  built.quiz = quiz;
  built.planner = planner;
  built.progress = progress;
  built.viva = viva;
  built.recommendations = recommendations;
  built.checks = checks;
  built.studyTools = studyTools;
  return built;
}
