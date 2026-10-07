import { sql } from "drizzle-orm";
import { BUG_REPORTS_PER_DAY, bugSeveritySchema, bugStatusSchema, bugTypeSchema, type BugReport, type BugReportList, type BugStatus, type CreateBugReportInput } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { AppError } from "../errors.js";

export interface BugRepository {
  /** Saves a report for the (server-verified) user. Refuses with 429 after BUG_REPORTS_PER_DAY reports in 24 hours. */
  create(userId: string, input: CreateBugReportInput): Promise<{ id: string }>;
  /** Admin inbox, newest first. */
  list(status: BugStatus | null, limit: number): Promise<BugReportList>;
  /** Marks a report resolved / open again and records it in the audit log. Null when the id does not exist. */
  setStatus(id: string, status: BugStatus, changedBy: string): Promise<BugReport | null>;
}

interface Row {
  id: string;
  title: string;
  description: string;
  page: string | null;
  status: string;
  type: string;
  severity: string;
  reporter_name: string | null;
  created_at: Date | string;
  resolved_at: Date | string | null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();
const toReport = (r: Row): BugReport => ({
  id: r.id,
  title: r.title,
  description: r.description,
  page: r.page,
  type: bugTypeSchema.parse(r.type),
  severity: bugSeveritySchema.parse(r.severity),
  status: bugStatusSchema.parse(r.status),
  reporterName: r.reporter_name,
  createdAt: iso(r.created_at),
  resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
});

/** Keeps only the path: no query string, no fragment, and nothing that is not an in-app path. */
export function cleanPage(page: string | undefined): string | null {
  if (!page) return null;
  const path = page.split(/[?#]/)[0]!.trim();
  return /^\/[\w\-./]*$/.test(path) ? path.slice(0, 120) : null;
}

const SELECT = sql`select b.id, b.title, b.description, b.page, b.status, b.type, b.severity, p.display_name as reporter_name, b.created_at, b.resolved_at from public.bug_reports b left join public.student_profiles p on p.id = b.user_id`;

export function createBugRepository(db: Database): BugRepository {
  const repo: BugRepository = {
    async create(userId, input) {
      const recent = (await db.execute(sql`select count(*)::int as n from public.bug_reports where user_id = ${userId} and created_at > now() - interval '24 hours'`)) as unknown as Array<{ n: number }>;
      if ((recent[0]?.n ?? 0) >= BUG_REPORTS_PER_DAY) {
        throw new AppError(429, "too_many_reports", `You've sent ${BUG_REPORTS_PER_DAY} reports today. Thank you - please try again tomorrow.`);
      }
      const rows = (await db.execute(sql`insert into public.bug_reports (user_id, title, description, page, type, severity) values (${userId}, ${input.title}, ${input.description}, ${cleanPage(input.page)}, ${input.type ?? "bug"}, ${input.severity ?? "medium"}) returning id`)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },

    async list(status, limit) {
      const where = status ? sql`where b.status = ${status}` : sql``;
      const rows = (await db.execute(sql`${SELECT} ${where} order by b.created_at desc, b.id limit ${limit + 1}`)) as unknown as Row[];
      const [c] = (await db.execute(sql`select count(*)::int as total, (count(*) filter (where status = 'open'))::int as open, (count(*) filter (where status = 'in_progress'))::int as in_progress, (count(*) filter (where status = 'resolved'))::int as resolved from public.bug_reports`)) as unknown as Array<{ total: number; open: number; in_progress: number; resolved: number }>;
      return { reports: rows.slice(0, limit).map(toReport), counts: { total: c?.total ?? 0, open: c?.open ?? 0, in_progress: c?.in_progress ?? 0, resolved: c?.resolved ?? 0 }, truncated: rows.length > limit };
    },

    async setStatus(id, status, changedBy) {
      const done = await db.transaction(async (tx) => {
        const updated = (await tx.execute(
          sql`update public.bug_reports set status = ${status}, resolved_at = ${status === "resolved" ? sql`now()` : null}, resolved_by = ${status === "resolved" ? changedBy : null} where id = ${id} returning id`,
        )) as unknown as Array<{ id: string }>;
        if (!updated[0]) return false;
        await tx.execute(sql`insert into public.audit_log (actor_id, action, target_id, detail) values (${changedBy}, ${status === "resolved" ? "bug_resolved" : status === "in_progress" ? "bug_in_progress" : "bug_reopened"}, ${id}, ${JSON.stringify({ status })}::jsonb)`);
        return true;
      });
      if (!done) return null;
      const rows = (await db.execute(sql`${SELECT} where b.id = ${id}`)) as unknown as Row[];
      return rows[0] ? toReport(rows[0]) : null;
    },
  };
  return repo;
}
