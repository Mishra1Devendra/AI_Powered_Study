ALTER TABLE "viva_questions" ADD COLUMN "source_ref" jsonb;--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD COLUMN "source_type" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD CONSTRAINT "viva_sessions_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viva_sessions_document_idx" ON "viva_sessions" USING btree ("document_id","user_id");--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD CONSTRAINT "viva_sessions_source_type_valid" CHECK ("viva_sessions"."source_type" in ('general', 'notes', 'document'));--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD CONSTRAINT "viva_sessions_source_consistent" CHECK (("viva_sessions"."source_type" = 'document') = ("viva_sessions"."document_id" is not null));