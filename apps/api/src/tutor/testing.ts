import { randomUUID } from "node:crypto";
import type { Conversation, TutorMessage } from "@copilot/shared";
import type { TutorRepository } from "./repository.js";

/**
 * In-memory TutorRepository for unit tests. It enforces the same ownership rule as the real
 * one (every lookup is scoped by user id), so service/route tests exercise isolation logic
 * without a database. Real database isolation is covered by the live RLS integration tests.
 */
export function createInMemoryTutorRepository(names: Record<string, string> = {}) {
  const convs = new Map<string, Conversation & { userId: string; deletedAt: string | null; documentId: string | null }>();
  const msgs: Array<TutorMessage & { userId: string }> = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 3, 12, 0, 0) + ++tick * 1000).toISOString();
  const strip = ({ userId: _u, deletedAt: _d, documentId: _doc, ...c }: Conversation & { userId: string; deletedAt: string | null; documentId: string | null }): Conversation => c;

  const repo: TutorRepository = {
    async getStudentName(userId) {
      return names[userId] ?? null;
    },
    async createConversation(userId, ctx) {
      const t = now();
      const c = {
        id: randomUUID(),
        userId,
        deletedAt: null,
        documentId: null,
        title: "New conversation",
        subject: ctx.subject ?? null,
        topic: ctx.topic ?? null,
        level: ctx.level ?? null,
        createdAt: t,
        updatedAt: t,
      };
      convs.set(c.id, c);
      return strip(c);
    },
    async listConversations(userId, limit) {
      return [...convs.values()]
        .filter((c) => c.userId === userId && !c.deletedAt && !c.documentId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map(strip);
    },
    async getConversation(userId, id) {
      const c = convs.get(id);
      return c && c.userId === userId && !c.deletedAt && !c.documentId ? strip(c) : null;
    },
    async updateConversation(userId, id, patch) {
      const c = convs.get(id);
      if (!c || c.userId !== userId || c.deletedAt || c.documentId) return null;
      if (patch.title !== undefined) c.title = patch.title;
      if (patch.subject !== undefined) c.subject = patch.subject ?? null;
      if (patch.topic !== undefined) c.topic = patch.topic ?? null;
      if (patch.level !== undefined) c.level = patch.level;
      c.updatedAt = now();
      return strip(c);
    },
    async archiveConversation(userId, id) {
      const c = convs.get(id);
      if (!c || c.userId !== userId || c.deletedAt || c.documentId) return false;
      c.deletedAt = now();
      return true;
    },
    async listMessages(userId, conversationId, limit) {
      return msgs
        .filter((m) => m.userId === userId && m.conversationId === conversationId)
        .slice(-limit)
        .map(({ userId: _u, ...m }) => m);
    },
    async addUserMessage(userId, conversationId, input) {
      const c = convs.get(conversationId);
      if (!c || c.userId !== userId) throw new Error("FK violation: conversation not owned");
      const m = {
        id: randomUUID(),
        conversationId,
        userId,
        role: "user" as const,
        content: input.content,
        mode: input.mode ?? null,
        action: input.action ?? null,
        model: null,
        isMock: false,
        createdAt: now(),
      };
      msgs.push(m);
      c.updatedAt = m.createdAt;
      const { userId: _u, ...out } = m;
      return out;
    },
    async addAssistantMessage(userId, conversationId, input) {
      const c = convs.get(conversationId);
      if (!c || c.userId !== userId) throw new Error("FK violation: conversation not owned");
      const m = {
        id: randomUUID(),
        conversationId,
        userId,
        role: "assistant" as const,
        content: input.content,
        mode: null,
        action: null,
        ...(input.sources && input.sources.length ? { sources: input.sources } : {}),
        ...(input.grounding ? { grounding: input.grounding } : {}),
        model: input.model,
        isMock: input.isMock,
        createdAt: now(),
      };
      msgs.push(m);
      c.updatedAt = m.createdAt;
      const { userId: _u, ...out } = m;
      return out;
    },
  };

  return { repo, convs, msgs };
}
