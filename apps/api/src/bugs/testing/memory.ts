import { BUG_REPORTS_PER_DAY, type BugReport } from "@copilot/shared";
import { AppError } from "../../errors.js";
import { cleanPage, type BugRepository } from "../repository.js";

/** In-memory BugRepository for tests. `names` maps user ids to display names. */
export function createInMemoryBugRepository(names: Record<string, string> = {}) {
  const rows: Array<BugReport & { userId: string }> = [];
  const audit: Array<{ action: string; by: string; target: string }> = [];
  const repo: BugRepository = {
    async create(userId, input) {
      if (rows.filter((r) => r.userId === userId).length >= BUG_REPORTS_PER_DAY) throw new AppError(429, "too_many_reports", "Too many reports today.");
      const id = `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      rows.unshift({ id, userId, title: input.title, description: input.description, page: cleanPage(input.page), type: input.type ?? "bug", severity: input.severity ?? "medium", status: "open", reporterName: names[userId] ?? null, createdAt: "2026-02-01T00:00:00.000Z", resolvedAt: null });
      return { id };
    },
    async list(status, limit) {
      const all = rows.filter((r) => !status || r.status === status);
      const strip = ({ userId: _u, ...r }: BugReport & { userId: string }): BugReport => r;
      const n = (s: BugReport["status"]) => rows.filter((r) => r.status === s).length;
      return { reports: all.slice(0, limit).map(strip), counts: { total: rows.length, open: n("open"), in_progress: n("in_progress"), resolved: n("resolved") }, truncated: all.length > limit };
    },
    async setStatus(id, status, changedBy) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      r.status = status;
      r.resolvedAt = status === "resolved" ? "2026-02-02T00:00:00.000Z" : null;
      audit.push({ action: status === "resolved" ? "bug_resolved" : status === "in_progress" ? "bug_in_progress" : "bug_reopened", by: changedBy, target: id });
      const { userId: _u, ...out } = r;
      return out;
    },
  };
  return { repo, rows, audit };
}
