import { sql } from "drizzle-orm";
import { AUDIT_LIST_LIMIT, accessStatusSchema, roleSchema, type AccessStatus, type AdminStudent, type AuditList, type Role } from "@copilot/shared";

/** The date range of the Audit Log screen (ISO timestamps; either end may be missing = unbounded). */
export interface AuditRange {
  from?: string | undefined;
  to?: string | undefined;
}
import type { Database } from "../db/client.js";

export interface AccessRecord {
  role: Role;
  accessStatus: AccessStatus;
}

/**
 * Who may use the app and who is an admin. Reads and writes run on the server's privileged connection (an admin must see
 * accounts that are not their own, which RLS correctly forbids for a student) - so EVERY caller must first prove the
 * requester is an admin from this same table, never from the token or the request body.
 */
export interface AccessRepository {
  /** The account's role and status, or null when the profile does not exist. */
  get(userId: string): Promise<AccessRecord | null>;
  listStudents(query: string | null, limit: number): Promise<{ rows: AdminStudent[]; total: number }>;
  getStudent(id: string): Promise<AdminStudent | null>;
  /** Pauses or restores a STUDENT account. Returns null when the id is not a student (admins cannot be paused). */
  setAccess(id: string, status: AccessStatus, changedBy: string): Promise<AdminStudent | null>;
  /** Newest first. Append-only history of admin actions (who, what, to whom, when) - never any content - plus real counts for the range. */
  listAudit(range?: AuditRange, limit?: number): Promise<AuditList>;
}

interface Row {
  id: string;
  display_name: string;
  email: string | null;
  role: string;
  access_status: string;
  created_at: Date | string;
  access_changed_at: Date | string | null;
  changed_by_name: string | null;
  last_sign_in_at: Date | string | null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

function toStudent(r: Row): AdminStudent {
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    role: roleSchema.parse(r.role),
    accessStatus: accessStatusSchema.parse(r.access_status),
    createdAt: iso(r.created_at),
    accessChangedAt: r.access_changed_at ? iso(r.access_changed_at) : null,
    accessChangedByName: r.changed_by_name,
    lastSignInAt: r.last_sign_in_at ? iso(r.last_sign_in_at) : null,
  };
}

/** Escapes LIKE wildcards so a search for "100%" or "a_b" is treated as plain text. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const SELECT = sql`select p.id, p.display_name, u.email, p.role, p.access_status, p.created_at, p.access_changed_at, cp.display_name as changed_by_name, u.last_sign_in_at from public.student_profiles p join auth.users u on u.id = p.id left join public.student_profiles cp on cp.id = p.access_changed_by`;

export function createAccessRepository(db: Database): AccessRepository {
  const searchWhere = (query: string | null) => {
    if (!query) return sql``;
    const pat = likePattern(query);
    return sql`where p.display_name ilike ${pat} or u.email ilike ${pat}`;
  };

  const repo: AccessRepository = {
    async get(userId) {
      const rows = (await db.execute(sql`select role, access_status from public.student_profiles where id = ${userId}`)) as unknown as Array<{ role: string; access_status: string }>;
      const r = rows[0];
      return r ? { role: roleSchema.parse(r.role), accessStatus: accessStatusSchema.parse(r.access_status) } : null;
    },

    async listStudents(query, limit) {
      const where = searchWhere(query);
      const rows = (await db.execute(sql`${SELECT} ${where} order by p.created_at desc limit ${limit}`)) as unknown as Row[];
      const counted = (await db.execute(sql`select count(*)::int as count from public.student_profiles p join auth.users u on u.id = p.id ${where}`)) as unknown as Array<{ count: number }>;
      return { rows: rows.map(toStudent), total: counted[0]?.count ?? 0 };
    },

    async getStudent(id) {
      const rows = (await db.execute(sql`${SELECT} where p.id = ${id}`)) as unknown as Row[];
      return rows[0] ? toStudent(rows[0]) : null;
    },

    async setAccess(id, status, changedBy) {
      // Students only: an administrator's own access can never be paused through this path. The change and its audit entry
      // are written together or not at all.
      const changed = await db.transaction(async (tx) => {
        const updated = (await tx.execute(
          sql`update public.student_profiles set access_status = ${status}, access_changed_at = now(), access_changed_by = ${changedBy} where id = ${id} and role = 'student' returning id`,
        )) as unknown as Array<{ id: string }>;
        if (!updated[0]) return false;
        await tx.execute(sql`insert into public.audit_log (actor_id, action, target_id, detail) values (${changedBy}, ${status === "revoked" ? "access_paused" : "access_restored"}, ${id}, ${JSON.stringify({ status })}::jsonb)`);
        return true;
      });
      return changed ? repo.getStudent(id) : null;
    },

    async listAudit(range = {}, limit = AUDIT_LIST_LIMIT) {
      const from = range.from ?? null;
      const to = range.to ?? null;
      const inRange = sql`(${from}::timestamptz is null or a.created_at >= ${from}::timestamptz) and (${to}::timestamptz is null or a.created_at < ${to}::timestamptz)`;
      const rows = (await db.execute(
        sql`select a.id, a.action, ap.display_name as actor_name, tp.display_name as target_name, a.created_at from public.audit_log a left join public.student_profiles ap on ap.id = a.actor_id left join public.student_profiles tp on tp.id = a.target_id where ${inRange} order by a.created_at desc, a.id limit ${limit + 1}`,
      )) as unknown as Array<{ id: string; action: string; actor_name: string | null; target_name: string | null; created_at: Date | string }>;
      const [r] = (await db.execute(
        sql`select count(*)::int as total, (count(*) filter (where a.action = 'access_paused'))::int as paused, (count(*) filter (where a.action = 'access_restored'))::int as restored, (count(*) filter (where a.action like 'bug\\_%'))::int as bug_changes from public.audit_log a where ${inRange}`,
      )) as unknown as Array<{ total: number; paused: number; restored: number; bug_changes: number }>;
      const [d] = (await db.execute(sql`select count(*)::int as n from public.audit_log where created_at > now() - interval '24 hours'`)) as unknown as Array<{ n: number }>;
      const [u] = (await db.execute(
        sql`select count(*)::int as total, (count(*) filter (where p.access_status = 'active'))::int as active, (count(*) filter (where p.access_status = 'revoked'))::int as paused, (count(*) filter (where u.last_sign_in_at is null))::int as never_signed_in, (count(*) filter (where u.last_sign_in_at < now() - interval '30 days'))::int as dormant, (count(*) filter (where u.last_sign_in_at >= now() - interval '30 days'))::int as signed_in_30d, (count(*) filter (where u.last_sign_in_at >= now() - interval '24 hours'))::int as active_24h from public.student_profiles p join auth.users u on u.id = p.id`,
      )) as unknown as Array<{ total: number; active: number; paused: number; never_signed_in: number; dormant: number; signed_in_30d: number; active_24h: number }>;
      return {
        entries: rows.slice(0, limit).map((e) => ({ id: e.id, action: e.action, actorName: e.actor_name, targetName: e.target_name, createdAt: iso(e.created_at) })),
        truncated: rows.length > limit,
        summary: {
          inRange: { total: r?.total ?? 0, paused: r?.paused ?? 0, restored: r?.restored ?? 0, bugChanges: r?.bug_changes ?? 0 },
          actions24h: d?.n ?? 0,
          activeUsers24h: u?.active_24h ?? 0,
          accounts: { total: u?.total ?? 0, active: u?.active ?? 0, paused: u?.paused ?? 0, neverSignedIn: u?.never_signed_in ?? 0, dormant30d: u?.dormant ?? 0, signedIn30d: u?.signed_in_30d ?? 0 },
        },
      };
    },
  };
  return repo;
}
