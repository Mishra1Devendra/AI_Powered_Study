CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"char_count" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_order_key" UNIQUE("document_id","user_id","chunk_index"),
	CONSTRAINT "document_chunks_content_len" CHECK (char_length("document_chunks"."content") between 1 and 20000),
	CONSTRAINT "document_chunks_index_valid" CHECK ("document_chunks"."chunk_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_type" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"storage_path" text NOT NULL,
	"processing_status" text DEFAULT 'uploading' NOT NULL,
	"processing_error" text,
	"page_count" integer,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"char_count" integer,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "documents_storage_path_key" UNIQUE("storage_path"),
	CONSTRAINT "documents_title_len" CHECK (char_length(btrim("documents"."title")) between 1 and 200),
	CONSTRAINT "documents_filename_len" CHECK (char_length("documents"."original_filename") between 1 and 255),
	CONSTRAINT "documents_file_type_valid" CHECK ("documents"."file_type" in ('pdf', 'txt', 'md')),
	CONSTRAINT "documents_source_valid" CHECK ("documents"."source" in ('upload', 'paste')),
	CONSTRAINT "documents_status_valid" CHECK ("documents"."processing_status" in ('uploading', 'processing', 'ready', 'failed')),
	CONSTRAINT "documents_error_len" CHECK ("documents"."processing_error" is null or char_length("documents"."processing_error") <= 500),
	CONSTRAINT "documents_size_valid" CHECK ("documents"."file_size" between 1 and 52428800),
	CONSTRAINT "documents_hash_valid" CHECK ("documents"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_storage_path_owner" CHECK ("documents"."storage_path" = "documents"."user_id"::text || '/' || "documents"."id"::text || '/original.' || "documents"."file_type")
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_user_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_chunks_search_idx" ON "document_chunks" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_user_hash_active_key" ON "documents" USING btree ("user_id","content_hash") WHERE "documents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "documents_user_recent_idx" ON "documents" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "documents"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_document_idx" ON "conversations" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_document_active_key" ON "conversations" USING btree ("document_id") WHERE "conversations"."document_id" is not null and "conversations"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_action_valid" CHECK ("messages"."action" is null or "messages"."action" in ('explain', 'summarize', 'key_concepts', 'definitions', 'formulas', 'flashcards', 'quiz', 'important_topics', 'ask'));--> statement-breakpoint
CREATE POLICY "document_chunks_select_own" ON "document_chunks" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "document_chunks"."user_id");--> statement-breakpoint
CREATE POLICY "documents_select_own" ON "documents" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "documents"."user_id");--> statement-breakpoint
CREATE POLICY "documents_update_own" ON "documents" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "documents"."user_id") WITH CHECK ((select auth.uid()) = "documents"."user_id");