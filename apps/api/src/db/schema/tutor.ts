import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";
import { documents } from "./documents.js";

/**
 * AI Tutor conversations. Each belongs to exactly one auth user.
 * Deleting is SOFT (`deleted_at`): clients have no DELETE privilege, so no history is ever
 * hard-deleted by the app without an explicit, separate decision.
 *
 * RLS: a signed-in user can read/insert/update only their own rows.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    /** Optional tutoring context chosen by the student. Never required. */
    subject: text("subject"),
    topic: text("topic"),
    /** Optional per-conversation level override: beginner | intermediate | advanced. */
    level: text("level"),
    /**
     * Set for an AI Notes assistant conversation (one per document). NULL = a general AI Tutor
     * conversation. The tutor never lists or opens conversations that have a document.
     */
    documentId: uuid("document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Lets `messages` carry (conversation_id, user_id) as a composite FK, so a message's owner
    // can never differ from its conversation's owner.
    unique("conversations_id_user_id_key").on(t.id, t.userId),
    // A notes conversation must belong to a document owned by the SAME student.
    foreignKey({
      name: "conversations_document_owner_fk",
      columns: [t.documentId, t.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete("cascade"),
    index("conversations_document_idx").on(t.documentId, t.userId),
    uniqueIndex("conversations_document_active_key")
      .on(t.documentId)
      .where(sql`${t.documentId} is not null and ${t.deletedAt} is null`),
    check("conversations_title_len", sql`char_length(btrim(${t.title})) between 1 and 120`),
    check("conversations_subject_len", sql`${t.subject} is null or char_length(${t.subject}) between 1 and 80`),
    check("conversations_topic_len", sql`${t.topic} is null or char_length(${t.topic}) between 1 and 120`),
    check("conversations_level_valid", sql`${t.level} is null or ${t.level} in ('beginner', 'intermediate', 'advanced')`),
    index("conversations_user_recent_idx")
      .on(t.userId, t.updatedAt.desc())
      .where(sql`${t.deletedAt} is null`),
    pgPolicy("conversations_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
    pgPolicy("conversations_insert_own", { for: "insert", to: authenticatedRole, withCheck: sql`${authUid} = ${t.userId}` }),
    pgPolicy("conversations_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
).enableRLS();

/**
 * Messages are append-only: no UPDATE or DELETE for clients. Students may insert only
 * `user` messages; assistant messages are written by the API server after generation, so
 * a client cannot forge what "the tutor said". Regenerating appends a new assistant message.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** Tutor mode the student chose for this turn (user messages only). */
    mode: text("mode"),
    /** AI Notes: the study action requested on a user message (summarize, flashcards, ...). */
    action: text("action"),
    /** Server-written facts about an assistant message, e.g. the document chunks it was grounded on. */
    metadata: jsonb("metadata"),
    /** Model that produced an assistant message (e.g. "llama3.2:3b" or "mock-demo"). */
    model: text("model"),
    /** True when an assistant message came from the demo/mock provider, never a real model. */
    isMock: boolean("is_mock").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "messages_conversation_owner_fk",
      columns: [t.conversationId, t.userId],
      foreignColumns: [conversations.id, conversations.userId],
    }).onDelete("cascade"),
    check("messages_role_valid", sql`${t.role} in ('user', 'assistant')`),
    check("messages_content_len", sql`char_length(${t.content}) between 1 and 100000`),
    check(
      "messages_mode_valid",
      sql`${t.mode} is null or ${t.mode} in ('explain_simply', 'step_by_step', 'example', 'hint', 'test_me', 'summarize', 'find_mistake', 'follow_up')`,
    ),
    check(
      "messages_action_valid",
      sql`${t.action} is null or ${t.action} in ('explain', 'summarize', 'key_concepts', 'definitions', 'formulas', 'flashcards', 'quiz', 'important_topics', 'ask')`,
    ),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    // Covers the composite owner FK (cascade checks) and the "this user's messages in this conversation" lookup.
    index("messages_conversation_owner_idx").on(t.conversationId, t.userId, t.createdAt),
    index("messages_user_idx").on(t.userId),
    pgPolicy("messages_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
    pgPolicy("messages_insert_own_user_role", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and ${t.role} = 'user'`,
    }),
  ],
).enableRLS();

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
