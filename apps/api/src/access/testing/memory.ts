import type { AccessStatus, AdminStudent, AuditEntry, Role } from "@copilot/shared";
import type { AccessRecord, AccessRepository, AuditRange } from "../repository.js";

export interface MemoryAccount {
  id: string;
  displayName: string;
  email: string | null;
  role: Role;
  accessStatus: AccessStatus;
  accessChangedAt?: string | null;
  accessChangedBy?: string | null;
  lastSignInAt?: string | null;
}

/** In-memory AccessRepository for tests. `state.lookups` counts get() calls so a test can prove the check really runs. */
export function createInMemoryAccessRepository(accounts: MemoryAccount[]) {
  const byId = new Map(accounts.map((a) => [a.id, { accessChangedAt: null, accessChangedBy: null, ...a }]));
  const view = (a: MemoryAccount): AdminStudent => ({
    id: a.id,
    displayName: a.displayName,
    email: a.email,
    role: a.role,
    accessStatus: a.accessStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    accessChangedAt: a.accessChangedAt ?? null,
    accessChangedByName: a.accessChangedBy ? (byId.get(a.accessChangedBy)?.displayName ?? null) : null,
    lastSignInAt: a.lastSignInAt ?? null,
  });
  const audit: AuditEntry[] = [];
  const state = { lookups: 0, byId, audit, now: () => Date.now() };
  const repo: AccessRepository = {
    async get(userId): Promise<AccessRecord | null> {
      state.lookups++;
      const a = byId.get(userId);
      return a ? { role: a.role, accessStatus: a.accessStatus } : null;
    },
    async listStudents(query, limit) {
      const needle = query?.toLowerCase() ?? null;
      const all = [...byId.values()].filter((a) => !needle || a.displayName.toLowerCase().includes(needle) || (a.email ?? "").toLowerCase().includes(needle));
      return { rows: all.slice(0, limit).map(view), total: all.length };
    },
    async getStudent(id) {
      const a = byId.get(id);
      return a ? view(a) : null;
    },
    async setAccess(id, status, changedBy) {
      const a = byId.get(id);
      if (!a || a.role !== "student") return null;
      a.accessStatus = status;
      a.accessChangedAt = "2026-02-01T00:00:00.000Z";
      a.accessChangedBy = changedBy;
      audit.unshift({ id: `00000000-0000-4000-8000-${String(audit.length + 1).padStart(12, "0")}`, action: status === "revoked" ? "access_paused" : "access_restored", actorName: byId.get(changedBy)?.displayName ?? null, targetName: a.displayName, createdAt: "2026-02-01T00:00:00.000Z" });
      return view(a);
    },
    async listAudit(range: AuditRange = {}, limit = 200) {
      const from = range.from ? Date.parse(range.from) : -Infinity;
      const to = range.to ? Date.parse(range.to) : Infinity;
      const inside = audit.filter((e) => Date.parse(e.createdAt) >= from && Date.parse(e.createdAt) < to);
      const all = [...byId.values()];
      const t = state.now();
      const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
      return {
        entries: inside.slice(0, limit),
        truncated: inside.length > limit,
        summary: {
          inRange: { total: inside.length, paused: inside.filter((e) => e.action === "access_paused").length, restored: inside.filter((e) => e.action === "access_restored").length, bugChanges: inside.filter((e) => e.action.startsWith("bug_")).length },
          actions24h: audit.filter((e) => t - Date.parse(e.createdAt) < 86_400_000).length,
          activeUsers24h: all.filter((a) => ms(a.lastSignInAt) !== null && t - ms(a.lastSignInAt)! < 86_400_000).length,
          accounts: {
            total: all.length,
            active: all.filter((a) => a.accessStatus === "active").length,
            paused: all.filter((a) => a.accessStatus === "revoked").length,
            neverSignedIn: all.filter((a) => !a.lastSignInAt).length,
            dormant30d: all.filter((a) => ms(a.lastSignInAt) !== null && t - ms(a.lastSignInAt)! > 30 * 86_400_000).length,
            signedIn30d: all.filter((a) => ms(a.lastSignInAt) !== null && t - ms(a.lastSignInAt)! <= 30 * 86_400_000).length,
          },
        },
      };
    },
  };
  return { repo, state };
}
