import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  foreignKey,
} from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "drizzle-orm/supabase";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Study material a student uploaded (PDF / TXT / Markdown / pasted text).
 * The original file lives in the PRIVATE Supabase Storage bucket `notes` at a path the SERVER
 * derives (`<user_id>/<document_id>/original.<ext>`) - never from user input; a CHECK enforces it.
 *
 * Lifecycle fields (status, counts, error) are written by the API server only. Clients can read
 * their own rows and edit just the title / soft-delete flag / last-activity stamp.
 * Deleting is SOFT (`deleted_at`); there is no client DELETE privilege.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    originalFilename: text("original_filename").notNull(),
    /** Detected by the server from file CONTENT, not trusted from the client. */
    fileType: text("file_type").notNull(),
    /** "upload" for files, "paste" for pasted text. */
    source: text("source").notNull().default("upload"),
    mimeType: text("mime_type").notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    /** SHA-256 of the file bytes, for duplicate detection per student. */
    contentHash: text("content_hash").notNull(),
    storagePath: text("storage_path").notNull(),
    processingStatus: text("processing_status").notNull().default("uploading"),
    /** Safe, student-readable reason when processing failed. */
    processingError: text("processing_error"),
    pageCount: integer("page_count"),
    chunkCount: integer("chunk_count").notNull().default(0),
    charCount: integer("char_count"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("documents_id_user_id_key").on(t.id, t.userId),
    unique("documents_storage_path_key").on(t.storagePath),
    check("documents_title_len", sql`char_length(btrim(${t.title})) between 1 and 200`),
    check("documents_filename_len", sql`char_length(${t.originalFilename}) between 1 and 255`),
    check("documents_file_type_valid", sql`${t.fileType} in ('pdf', 'txt', 'md')`),
    check("documents_source_valid", sql`${t.source} in ('upload', 'paste')`),
    check("documents_status_valid", sql`${t.processingStatus} in ('uploading', 'processing', 'ready', 'failed')`),
    check("documents_error_len", sql`${t.processingError} is null or char_length(${t.processingError}) <= 500`),
    check("documents_size_valid", sql`${t.fileSize} between 1 and 52428800`),
    check("documents_hash_valid", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    // The storage path can only ever be this student's own folder for this document.
    check("documents_storage_path_owner", sql`${t.storagePath} = ${t.userId}::text || '/' || ${t.id}::text || '/original.' || ${t.fileType}`),
    uniqueIndex("documents_user_hash_active_key").on(t.userId, t.contentHash).where(sql`${t.deletedAt} is null`),
    index("documents_user_recent_idx")
      .on(t.userId, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    pgPolicy("documents_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
    pgPolicy("documents_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
).enableRLS();

/**
 * Extracted, cleaned and split text of a document. Written by the server only; students can
 * read their own chunks. Chunks are never edited or deleted by the app.
 * `search_tsv` powers simple full-text retrieval today and leaves room for embeddings later.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    charCount: integer("char_count").notNull(),
    /** { page?, pageEnd?, heading?, headingPath?, source } - only what the file really provides. */
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, content)`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "document_chunks_document_owner_fk",
      columns: [t.documentId, t.userId],
      foreignColumns: [documents.id, documents.userId],
    }).onDelete("cascade"),
    unique("document_chunks_order_key").on(t.documentId, t.userId, t.chunkIndex),
    check("document_chunks_content_len", sql`char_length(${t.content}) between 1 and 20000`),
    check("document_chunks_index_valid", sql`${t.chunkIndex} >= 0`),
    index("document_chunks_user_idx").on(t.userId),
    index("document_chunks_search_idx").using("gin", t.searchTsv),
    pgPolicy("document_chunks_select_own", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
).enableRLS();

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
