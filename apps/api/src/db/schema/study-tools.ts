import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * Flashcards and mind maps. Server-only tables (migration 0018): RLS is on and no client role has a grant or a policy, so the
 * browser can only reach them through the API, which scopes every query by the verified user id.
 */

export const flashcardDecks = pgTable(
  "flashcard_decks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** "notes" | "topic" | "manual". */
    sourceType: text("source_type").notNull(),
    status: text("status").notNull().default("ready"),
    error: text("error"),
    provider: text("provider"),
    model: text("model"),
    isMock: boolean("is_mock").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("flashcard_decks_id_user_unique").on(t.id, t.userId),
    check("flashcard_decks_source_valid", sql`${t.sourceType} in ('notes', 'topic', 'manual')`),
    check("flashcard_decks_status_valid", sql`${t.status} in ('generating', 'ready', 'error')`),
    index("flashcard_decks_user_created_idx").on(t.userId, t.createdAt),
  ],
).enableRLS();

export const flashcards = pgTable(
  "flashcards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deckId: uuid("deck_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    hint: text("hint"),
    position: integer("position").notNull().default(0),
    /** Spaced repetition (SM-2 style): ease in hundredths (250 = 2.5), interval in days. */
    easeX100: integer("ease_x100").notNull().default(250),
    intervalDays: integer("interval_days").notNull().default(0),
    repetitions: integer("repetitions").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "flashcards_deck_owner_fk", columns: [t.deckId, t.userId], foreignColumns: [flashcardDecks.id, flashcardDecks.userId] }).onDelete("cascade"),
    check("flashcards_ease_range", sql`${t.easeX100} between 130 and 400`),
    index("flashcards_deck_idx").on(t.deckId, t.position),
    index("flashcards_user_due_idx").on(t.userId, t.dueAt),
  ],
).enableRLS();

export const mindmaps = pgTable(
  "mindmaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(),
    /** What it was made from, so it can be made again: the note ids, focus, subject and topic. */
    source: jsonb("source").notNull(),
    size: text("size").notNull().default("medium"),
    status: text("status").notNull().default("generating"),
    error: text("error"),
    /** The nested tree ({ id, label, note?, children[] }). Null until generated. */
    tree: jsonb("tree"),
    nodeCount: integer("node_count").notNull().default(0),
    provider: text("provider"),
    model: text("model"),
    isMock: boolean("is_mock").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("mindmaps_source_valid", sql`${t.sourceType} in ('notes', 'topic')`),
    check("mindmaps_size_valid", sql`${t.size} in ('small', 'medium', 'large')`),
    check("mindmaps_status_valid", sql`${t.status} in ('generating', 'ready', 'error')`),
    index("mindmaps_user_created_idx").on(t.userId, t.createdAt),
  ],
).enableRLS();

export type FlashcardDeckRow = typeof flashcardDecks.$inferSelect;
export type FlashcardRow = typeof flashcards.$inferSelect;
export type MindmapRow = typeof mindmaps.$inferSelect;
