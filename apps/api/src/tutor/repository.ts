import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { groundingOutcomeSchema, sourceRefSchema, type Conversation, type GroundingOutcome, type SourceRef, type TutorLevel, type TutorMessage, type TutorMode } from "@copilot/shared";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { conversations, messages, studentProfiles } from "../db/schema/index.js";
import { withUser } from "../db/with-user.js";

export interface ConversationContext {
  subject?: string | null;
  topic?: string | null;
  level?: TutorLevel | null;
}

export interface ConversationPatch extends ConversationContext {
  title?: string;
}

export interface UserMessageInput {
  content: string;
  /** AI Tutor mode. */
  mode?: TutorMode | null;
  /** AI Notes study action. */
  action?: string | null;
}

export interface AssistantMessageInput {
  content: string;
  model: string;
  isMock: boolean;
  /** AI Notes: the document passages the answer was grounded on. */
  sources?: SourceRef[];
  /** Phase 11: how the answer relates to the student's notes. */
  grounding?: GroundingOutcome;
}

/**
 * Persistence for conversations and messages. Every method takes the verified `userId` and every
 * query on user data runs through `withUser`, so Row Level Security enforces ownership in the
 * database in addition to the explicit `user_id` filters below.
 *
 * Conversation methods here cover the general AI TUTOR only (`document_id IS NULL`). The AI Notes
 * assistant keeps its per-document conversations in the notes repository, but shares the message
 * methods below, which work on any conversation the student owns.
 */
export interface TutorRepository {
  getStudentName(userId: string): Promise<string | null>;
  createConversation(userId: string, ctx: ConversationContext): Promise<Conversation>;
  listConversations(userId: string, limit: number): Promise<Conversation[]>;
  getConversation(userId: string, id: string): Promise<Conversation | null>;
  updateConversation(userId: string, id: string, patch: ConversationPatch): Promise<Conversation | null>;
  /** Soft delete: hides the conversation; rows are retained. */
  archiveConversation(userId: string, id: string): Promise<boolean>;
  listMessages(userId: string, conversationId: string, limit: number): Promise<TutorMessage[]>;
  addUserMessage(userId: string, conversationId: string, input: UserMessageInput): Promise<TutorMessage>;
  /** Written by the server only (privileged); clients cannot insert assistant messages. */
  addAssistantMessage(userId: string, conversationId: string, input: AssistantMessageInput): Promise<TutorMessage>;
}

type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

const metadataSchema = z.object({ sources: z.array(sourceRefSchema).optional(), grounding: groundingOutcomeSchema.optional() });

/** Reads the server-written sources and grounding out of a message's metadata, ignoring anything malformed. */
function metadataOf(metadata: unknown): { sources?: SourceRef[]; grounding?: GroundingOutcome } {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) return {};
  const { sources, grounding } = parsed.data;
  return { ...(sources && sources.length > 0 ? { sources } : {}), ...(grounding ? { grounding } : {}) };
}

export const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  topic: r.topic,
  level: (r.level as TutorLevel | null) ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toMessage = (r: MessageRow): TutorMessage => {
  const { sources, grounding } = metadataOf(r.metadata);
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role as "user" | "assistant",
    content: r.content,
    mode: (r.mode as TutorMode | null) ?? null,
    action: r.action,
    ...(sources ? { sources } : {}),
    ...(grounding ? { grounding } : {}),
    model: r.model,
    isMock: r.isMock,
    createdAt: r.createdAt.toISOString(),
  };
};

/** Row shapes returned by the column-limited raw inserts below (snake_case, as Postgres sends them). */
export type RawConversationRow = {
  id: string;
  title: string;
  subject: string | null;
  topic: string | null;
  level: string | null;
  created_at: Date;
  updated_at: Date;
};
type RawMessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  mode: string | null;
  action: string | null;
  model: string | null;
  is_mock: boolean;
  created_at: Date;
};
export const rawToConversation = (r: RawConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  subject: r.subject,
  topic: r.topic,
  level: (r.level as TutorLevel | null) ?? null,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});
const rawToMessage = (r: RawMessageRow): TutorMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role as "user" | "assistant",
  content: r.content,
  mode: (r.mode as TutorMode | null) ?? null,
  action: r.action,
  model: r.model,
  isMock: r.is_mock,
  createdAt: new Date(r.created_at).toISOString(),
});

const orNull = (v: string | null | undefined) => (v === undefined ? undefined : v);

/** The tutor never sees document (notes) conversations. */
const tutorOnly = isNull(conversations.documentId);

export function createTutorRepository(db: Database): TutorRepository {
  return {
    async getStudentName(userId) {
      const [row] = await withUser(db, userId, (tx) =>
        tx.select({ name: studentProfiles.displayName }).from(studentProfiles).where(eq(studentProfiles.id, userId)),
      );
      return row?.name ?? null;
    },

    async createConversation(userId, ctx) {
      // Column-limited INSERT: clients are only granted specific columns, and Drizzle would
      // otherwise list every column (as DEFAULT), which Postgres would reject.
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<RawConversationRow>(sql`
          insert into public.conversations (user_id, subject, topic, level)
          values (${userId}, ${ctx.subject ?? null}, ${ctx.topic ?? null}, ${ctx.level ?? null})
          returning id, title, subject, topic, level, created_at, updated_at`),
      );
      return rawToConversation(rows[0]!);
    },

    async listConversations(userId, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt), tutorOnly))
          .orderBy(desc(conversations.updatedAt))
          .limit(limit),
      );
      return rows.map(toConversation);
    },

    async getConversation(userId, id) {
      const [row] = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt), tutorOnly)),
      );
      return row ? toConversation(row) : null;
    },

    async updateConversation(userId, id, patch) {
      const set: Partial<typeof conversations.$inferInsert> = {};
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.subject !== undefined) set.subject = orNull(patch.subject) ?? null;
      if (patch.topic !== undefined) set.topic = orNull(patch.topic) ?? null;
      if (patch.level !== undefined) set.level = patch.level;
      if (Object.keys(set).length === 0) return this.getConversation(userId, id);
      const [row] = await withUser(db, userId, (tx) =>
        tx
          .update(conversations)
          .set(set)
          .where(and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt), tutorOnly))
          .returning(),
      );
      return row ? toConversation(row) : null;
    },

    async archiveConversation(userId, id) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .update(conversations)
          .set({ deletedAt: new Date() })
          .where(and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt), tutorOnly))
          .returning({ id: conversations.id }),
      );
      return rows.length > 0;
    },

    async listMessages(userId, conversationId, limit) {
      const rows = await withUser(db, userId, (tx) =>
        tx
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), eq(messages.userId, userId)))
          .orderBy(desc(messages.createdAt), asc(messages.role)) // role tie-break: a reply sorts after its question
          .limit(limit),
      );
      return rows.reverse().map(toMessage);
    },

    async addUserMessage(userId, conversationId, input) {
      // Column-limited INSERT (see createConversation). Role is fixed to "user": clients cannot
      // write assistant messages, and RLS rejects anything else.
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<RawMessageRow>(sql`
          insert into public.messages (conversation_id, user_id, role, content, mode, action)
          values (${conversationId}, ${userId}, 'user', ${input.content}, ${input.mode ?? null}, ${input.action ?? null})
          returning id, conversation_id, role, content, mode, action, model, is_mock, created_at`),
      );
      return rawToMessage(rows[0]!);
    },

    async addAssistantMessage(userId, conversationId, input) {
      // Privileged write (no RLS): the caller has already proven ownership, and the composite FK
      // (conversation_id, user_id) guarantees the owner pair is consistent.
      const [row] = await db
        .insert(messages)
        .values({
          conversationId,
          userId,
          role: "assistant",
          content: input.content,
          model: input.model,
          isMock: input.isMock,
          metadata: (input.sources && input.sources.length > 0) || input.grounding ? { ...(input.sources && input.sources.length > 0 ? { sources: input.sources } : {}), ...(input.grounding ? { grounding: input.grounding } : {}) } : null,
        })
        .returning();
      return toMessage(row!);
    },
  };
}
