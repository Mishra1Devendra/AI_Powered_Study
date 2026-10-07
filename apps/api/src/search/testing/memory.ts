import { SEARCH_LIMITS, type SearchHit, type SearchResponse } from "@copilot/shared";
import type { SearchRepository } from "../repository.js";

interface Row {
  userId: string;
  id: string;
  title: string;
  detail: string | null;
  href: string;
  /** Extra text that is searched too (subject / topic / file name). */
  text?: string;
}
type Group = "documents" | "quizzes" | "plans" | "conversations";

/**
 * In-memory SearchRepository for unit and route tests. Like the real one it only ever returns the asking student's own
 * rows, matches case-insensitively, limits every group, and treats `%` and `_` literally. (The real SQL and RLS are covered
 * by the live-database integration test.)
 */
export function createInMemorySearchRepository() {
  const rows: Record<Group, Row[]> = { documents: [], quizzes: [], plans: [], conversations: [] };
  const topics: Array<{ userId: string; subject: string | null; topic: string | null }> = [];
  const calls: Array<{ userId: string; query: string }> = [];
  const knobs = { fail: false };

  const repo: SearchRepository = {
    async search(userId, query) {
      calls.push({ userId, query });
      if (knobs.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      const needle = query.toLowerCase();
      const pick = (g: Group): SearchHit[] =>
        rows[g]
          .filter((r) => r.userId === userId && `${r.title} ${r.text ?? ""}`.toLowerCase().includes(needle))
          .slice(0, SEARCH_LIMITS.perGroup)
          .map(({ id, title, detail, href }) => ({ id, title, detail, href }));
      const mine = topics.filter((t) => t.userId === userId && `${t.subject ?? ""} ${t.topic ?? ""}`.toLowerCase().includes(needle));
      const response: SearchResponse = {
        query,
        documents: pick("documents"),
        quizzes: pick("quizzes"),
        plans: pick("plans"),
        conversations: pick("conversations"),
        topics: mine.slice(0, SEARCH_LIMITS.perGroup + 1).map(({ subject, topic }) => ({ subject, topic })),
      };
      return response;
    },
  };

  return {
    repo,
    calls,
    knobs,
    add: (group: Group, row: Row) => void rows[group].push(row),
    addTopic: (userId: string, subject: string | null, topic: string | null) => void topics.push({ userId, subject, topic }),
  };
}
