import type { CheckMeta, CheckRecord, CheckRepository, StoredCheckQuestion } from "./repository.js";

/** In-memory CheckRepository for tests. Mirrors the SQL rules (status transitions, per-user scoping). */
export function createInMemoryCheckRepository(now: () => Date = () => new Date()) {
  const rows: CheckRecord[] = [];
  let n = 0;
  const own = (userId: string, id: string) => rows.find((r) => r.id === id && r.userId === userId) ?? null;
  const repo: CheckRepository = {
    async create(userId, sessionId) {
      const t = now();
      const rec: CheckRecord = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, userId, sessionId, status: "generating", questions: null, answers: null, score: null, error: null, isMock: false, createdAt: t, updatedAt: t };
      rows.push(rec);
      return { ...rec };
    },
    async get(userId, id) {
      const r = own(userId, id);
      return r ? { ...r } : null;
    },
    async latest(userId, sessionId) {
      const list = rows.filter((r) => r.userId === userId && r.sessionId === sessionId);
      const r = list[list.length - 1];
      return r ? { ...r } : null;
    },
    async previousQuestionTexts(userId, sessionId, limit) {
      return rows
        .filter((r) => r.userId === userId && r.sessionId === sessionId && !r.isMock)
        .reverse()
        .flatMap((r) => (r.questions ?? []).map((q) => q.text))
        .slice(0, limit);
    },
    async countSince(userId, sessionId, since) {
      return rows.filter((r) => r.userId === userId && r.sessionId === sessionId && r.createdAt > since).length;
    },
    async hasPassed(userId, sessionId) {
      return rows.some((r) => r.userId === userId && r.sessionId === sessionId && r.status === "passed");
    },
    async setReady(userId, id, questions: StoredCheckQuestion[], meta: CheckMeta) {
      const r = own(userId, id);
      if (!r || r.status !== "generating") return false;
      Object.assign(r, { status: "ready", questions, isMock: meta.isMock, updatedAt: now() });
      return true;
    },
    async setError(userId, id, error, meta) {
      const r = own(userId, id);
      if (!r || r.status !== "generating") return;
      Object.assign(r, { status: "error", error, ...(meta ? { isMock: meta.isMock } : {}), updatedAt: now() });
    },
    async failStale(userId, sessionId, olderThan, keepIds) {
      const stale = rows.filter((r) => r.userId === userId && r.sessionId === sessionId && r.status === "generating" && r.updatedAt < olderThan && !keepIds.includes(r.id));
      for (const r of stale) Object.assign(r, { status: "error", error: "Creating the questions was interrupted. Please try again.", updatedAt: now() });
      return stale.length;
    },
    async submit(userId, id, answers, score, passed) {
      const r = own(userId, id);
      if (!r || r.status !== "ready") return null;
      Object.assign(r, { status: passed ? "passed" : "failed", answers, score, updatedAt: now() });
      return { ...r };
    },
  };
  return { repo, rows };
}
