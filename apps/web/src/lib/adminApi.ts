import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminStudentListSchema,
  aiStatusSchema,
  auditListSchema,
  bugReportListSchema,
  createBugReportResponseSchema,
  setAccessResponseSchema,
  setBugStatusResponseSchema,
  type AccessStatus,
  type AdminStudent,
  type AdminStudentList,
  type AiStatusReport,
  type AuditList,
  type BugReport,
  type BugReportList,
  type BugStatus,
  type CreateBugReportInput,
} from "@copilot/shared";
import { request } from "./api";

export const fetchAdminStudents = (client: SupabaseClient, q: string): Promise<AdminStudentList> =>
  request(client, `/api/admin/students${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, adminStudentListSchema);

export async function setStudentAccess(client: SupabaseClient, id: string, status: AccessStatus): Promise<AdminStudent> {
  const res = await request(client, `/api/admin/students/${encodeURIComponent(id)}/access`, setAccessResponseSchema, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  return res.student;
}

export const fetchAiStatus = (client: SupabaseClient): Promise<AiStatusReport> => request(client, "/api/admin/ai-status", aiStatusSchema);

export function fetchAuditLog(client: SupabaseClient, range: { from?: string; to?: string } = {}): Promise<AuditList> {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  const qs = params.toString();
  return request(client, `/api/admin/audit-log${qs ? `?${qs}` : ""}`, auditListSchema);
}

/** Every report (the Bug Tracker board shows them in three columns and filters in the browser). */
export const fetchBugReports = (client: SupabaseClient): Promise<BugReportList> => request(client, "/api/admin/bug-reports", bugReportListSchema);

export async function setBugStatus(client: SupabaseClient, id: string, status: BugStatus): Promise<BugReport> {
  const res = await request(client, `/api/admin/bug-reports/${encodeURIComponent(id)}/status`, setBugStatusResponseSchema, { method: "POST", body: JSON.stringify({ status }) });
  return res.report;
}

/** Any signed-in account may report a bug. */
export async function submitBugReport(client: SupabaseClient, input: CreateBugReportInput): Promise<void> {
  await request(client, "/api/bug-reports", createBugReportResponseSchema, { method: "POST", body: JSON.stringify(input) });
}
