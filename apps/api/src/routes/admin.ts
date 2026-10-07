import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import {
  ADMIN_LIST_LIMIT,
  AUDIT_LIST_LIMIT,
  adminStudentListSchema,
  aiStatusSchema,
  auditListSchema,
  auditQuerySchema,
  bugReportListSchema,
  bugStatusSchema,
  setAccessInputSchema,
  setAccessResponseSchema,
  setBugStatusInputSchema,
  setBugStatusResponseSchema,
  type AdminStudentList,
  type AiStatusReport,
  type AuditList,
  type BugReportList,
} from "@copilot/shared";
import type { AccessRepository } from "../access/repository.js";
import type { BugRepository } from "../bugs/repository.js";
import type { LLMProvider } from "../services/ai/index.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";

interface Deps {
  repo: AccessRepository;
  /** The AI provider, for the admin AI status screen (read only: it makes no AI request). */
  ai?: LLMProvider | undefined;
  /** The bug-report inbox (admins read it and mark reports resolved). Absent = those routes are not registered. */
  bugs?: BugRepository | undefined;
  /** Valid token AND an account that has not been paused. */
  authenticate: preHandlerAsyncHookHandler;
  /** Passes only when the verified requester is an administrator according to the database (never the token or the request). */
  requireAdmin: preHandlerAsyncHookHandler;
}

const listQuery = z.object({ q: z.string().trim().max(80).optional() });
const bugListQuery = z.object({ status: bugStatusSchema.optional() });
const idParams = z.object({ id: z.string().uuid("That isn't a valid id.") });

/**
 * Admin API. Admins see who has an account, can pause or restore a student's access, read the audit log and work through
 * the bug-report inbox. They never see study content (notes, chats, answers). Every route requires `authenticate` AND `requireAdmin`.
 */
export async function adminRoutes(app: FastifyInstance, { repo, bugs, ai, authenticate, requireAdmin }: Deps) {
  const guard = { preHandler: [authenticate, requireAdmin] };

  app.get("/api/admin/students", guard, async (req): Promise<AdminStudentList> => {
    const { q } = listQuery.parse(req.query);
    const { rows, total } = await repo.listStudents(q ? q : null, ADMIN_LIST_LIMIT);
    return adminStudentListSchema.parse({ students: rows, total, truncated: total > rows.length });
  });

  app.post("/api/admin/students/:id/access", guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const { status } = setAccessInputSchema.parse(req.body);
    const admin = req.user!;
    if (id === admin.id) throw new BadRequestError("You can't change your own access.");
    const target = await repo.getStudent(id);
    if (!target) throw new NotFoundError("Student not found.");
    if (target.role === "admin") throw new ForbiddenError("Administrator accounts can't be paused here.");
    // The change and its audit-log entry are written together inside the repository.
    const updated = await repo.setAccess(id, status, admin.id);
    if (!updated) throw new NotFoundError("Student not found.");
    // Ids only: no names, emails or content in the log.
    req.log.info({ event: "admin_access_change", by: admin.id, target: id, status }, "access changed");
    return setAccessResponseSchema.parse({ student: updated });
  });

  // Which AI is working and its free limit. Administrators only: students and the public health check see only the generic label.
  if (ai) {
    app.get("/api/admin/ai-status", guard, async (): Promise<AiStatusReport> => {
      if (ai.status) return aiStatusSchema.parse(await ai.status());
      // Local-only or demo mode: a one-line report with no online services.
      const now = new Date().toISOString();
      return aiStatusSchema.parse({
        mode: ai.isMock ? "mock" : "ollama",
        localPosition: null,
        lastAnswered: null,
        countersSince: now,
        steps: [
          {
            order: 1,
            service: ai.isMock ? "Demo AI (canned replies)" : "Local AI (Ollama)",
            model: ai.model,
            where: "this_computer",
            state: "ready",
            restingSeconds: 0,
            usedToday: 0,
            limitPerMinute: null,
            limitPerDay: null,
            limitNote: ai.isMock ? "Demo replies only; no real AI is running." : "No service limit: it runs on this computer. No free online service is configured.",
            lastResult: null,
            lastAt: null,
          },
        ],
      });
    });
  }

  app.get("/api/admin/audit-log", guard, async (req): Promise<AuditList> => {
    const range = auditQuerySchema.parse(req.query);
    return auditListSchema.parse(await repo.listAudit(range, AUDIT_LIST_LIMIT));
  });

  if (bugs) {
    app.get("/api/admin/bug-reports", guard, async (req): Promise<BugReportList> => {
      const { status } = bugListQuery.parse(req.query);
      return bugReportListSchema.parse(await bugs.list(status ?? null, ADMIN_LIST_LIMIT));
    });

    app.post("/api/admin/bug-reports/:id/status", guard, async (req) => {
      const { id } = idParams.parse(req.params);
      const { status } = setBugStatusInputSchema.parse(req.body);
      const report = await bugs.setStatus(id, status, req.user!.id);
      if (!report) throw new NotFoundError("Bug report not found.");
      req.log.info({ event: "admin_bug_status", by: req.user!.id, id, status }, "bug report status changed");
      return setBugStatusResponseSchema.parse({ report });
    });
  }
}
