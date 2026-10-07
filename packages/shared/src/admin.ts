import { z } from "zod";

/** The two roles. "student" is the default for everyone who signs up; "admin" is granted only by an existing admin or the one-time promote script. */
export const roleSchema = z.enum(["student", "admin"]);
export type Role = z.infer<typeof roleSchema>;

/** "active" = can use the app. "revoked" = an admin paused this account; nothing is deleted and access can be restored. */
export const accessStatusSchema = z.enum(["active", "revoked"]);
export type AccessStatus = z.infer<typeof accessStatusSchema>;

/** What an admin sees about an account: who it is and whether it has access. Never any study content (notes, answers, chats). */
export const adminStudentSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  role: roleSchema,
  accessStatus: accessStatusSchema,
  createdAt: z.string(),
  accessChangedAt: z.string().nullable(),
  /** Display name of the admin who last paused or restored this account (null if never changed or that admin no longer exists). */
  accessChangedByName: z.string().nullable(),
  /** From the auth service; null if the person never signed in. */
  lastSignInAt: z.string().nullable(),
});
export type AdminStudent = z.infer<typeof adminStudentSchema>;

export const adminStudentListSchema = z.object({
  students: z.array(adminStudentSchema),
  total: z.number().int().nonnegative(),
  /** True when more accounts match than were returned (narrow the search). */
  truncated: z.boolean(),
});
export type AdminStudentList = z.infer<typeof adminStudentListSchema>;

export const setAccessInputSchema = z.object({ status: accessStatusSchema }).strict();
export type SetAccessInput = z.infer<typeof setAccessInputSchema>;

export const setAccessResponseSchema = z.object({ student: adminStudentSchema });
export type SetAccessResponse = z.infer<typeof setAccessResponseSchema>;

/** Rows the admin lists fetch at most (the screens show them 20 per page). */
export const ADMIN_LIST_LIMIT = 500;
export const ACCESS_REVOKED_CODE = "access_revoked";
export const ACCESS_REVOKED_MESSAGE = "Your access has been paused by an administrator. Please contact them to restore it.";

/* ---- Audit log (admins only) ---- */

export const AUDIT_LIST_LIMIT = 500;

export const auditActionSchema = z.enum(["access_paused", "access_restored", "bug_in_progress", "bug_resolved", "bug_reopened"]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditQuerySchema = z.object({
  /** ISO timestamps from the browser's chosen range (inclusive start, exclusive end). Either may be missing for "all time". */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  /** Display name of the person who did it (null if their account no longer exists). */
  actorName: z.string().nullable(),
  /** Display name of the account it was done to, when there is one. */
  targetName: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * Numbers for the Audit Log screen. Only things this app really records are counted: admin actions, and account sign-ins taken from
 * the auth service's own "last sign-in" time. Failed sign-ins and page views are not recorded, so they are not shown.
 */
export const auditSummarySchema = z.object({
  /** Entries in the chosen date range, by kind. */
  inRange: z.object({ total: z.number().int(), paused: z.number().int(), restored: z.number().int(), bugChanges: z.number().int() }),
  /** Always the last 24 hours, whatever the range. */
  actions24h: z.number().int(),
  activeUsers24h: z.number().int(),
  /** Accounts (all time). */
  accounts: z.object({ total: z.number().int(), active: z.number().int(), paused: z.number().int(), neverSignedIn: z.number().int(), dormant30d: z.number().int(), signedIn30d: z.number().int() }),
});
export type AuditSummary = z.infer<typeof auditSummarySchema>;

export const auditListSchema = z.object({ entries: z.array(auditEntrySchema), truncated: z.boolean(), summary: auditSummarySchema });
export type AuditList = z.infer<typeof auditListSchema>;

/* ---- Bug reports ---- */

export const bugStatusSchema = z.enum(["open", "in_progress", "resolved"]);
export const BUG_STATUS_LABEL: Record<"open" | "in_progress" | "resolved", string> = { open: "Open", in_progress: "In progress", resolved: "Resolved" };

export const bugTypeSchema = z.enum(["bug", "feature", "other"]);
export type BugType = z.infer<typeof bugTypeSchema>;
export const BUG_TYPE_LABEL: Record<BugType, string> = { bug: "Bug", feature: "Feature", other: "Other" };

export const bugSeveritySchema = z.enum(["low", "medium", "high"]);
export type BugSeverity = z.infer<typeof bugSeveritySchema>;
export const BUG_SEVERITY_LABEL: Record<BugSeverity, string> = { low: "Low", medium: "Medium", high: "High" };
export type BugStatus = z.infer<typeof bugStatusSchema>;

export const BUG_TITLE_MAX = 120;
export const BUG_DESCRIPTION_MAX = 2000;
export const BUG_REPORTS_PER_DAY = 10;

export const createBugReportInputSchema = z
  .object({
    title: z.string().trim().min(3, "Give the problem a short title (at least 3 characters).").max(BUG_TITLE_MAX, `Keep the title under ${BUG_TITLE_MAX} characters.`),
    description: z.string().trim().min(10, "Describe what happened (at least 10 characters).").max(BUG_DESCRIPTION_MAX, `Keep the description under ${BUG_DESCRIPTION_MAX} characters.`),
    /** Where the person was, e.g. "/quiz". Optional; query strings are dropped by the server. */
    page: z.string().trim().max(200).optional(),
    /** Defaults to a bug of medium severity. */
    type: bugTypeSchema.optional(),
    severity: bugSeveritySchema.optional(),
  })
  .strict();
export type CreateBugReportInput = z.infer<typeof createBugReportInputSchema>;

export const createBugReportResponseSchema = z.object({ id: z.string().uuid() });

export const bugReportSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  page: z.string().nullable(),
  type: bugTypeSchema,
  severity: bugSeveritySchema,
  status: bugStatusSchema,
  reporterName: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type BugReport = z.infer<typeof bugReportSchema>;

export const bugCountsSchema = z.object({ total: z.number().int(), open: z.number().int(), in_progress: z.number().int(), resolved: z.number().int() });
export type BugCounts = z.infer<typeof bugCountsSchema>;

export const bugReportListSchema = z.object({ reports: z.array(bugReportSchema), counts: bugCountsSchema, truncated: z.boolean() });
export type BugReportList = z.infer<typeof bugReportListSchema>;

export const setBugStatusInputSchema = z.object({ status: bugStatusSchema }).strict();
export const setBugStatusResponseSchema = z.object({ report: bugReportSchema });
