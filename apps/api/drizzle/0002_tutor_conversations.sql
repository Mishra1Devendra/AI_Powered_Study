CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"subject" text,
	"topic" text,
	"level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conversations_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "conversations_title_len" CHECK (char_length(btrim("conversations"."title")) between 1 and 120),
	CONSTRAINT "conversations_subject_len" CHECK ("conversations"."subject" is null or char_length("conversations"."subject") between 1 and 80),
	CONSTRAINT "conversations_topic_len" CHECK ("conversations"."topic" is null or char_length("conversations"."topic") between 1 and 120),
	CONSTRAINT "conversations_level_valid" CHECK ("conversations"."level" is null or "conversations"."level" in ('beginner', 'intermediate', 'advanced'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"mode" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_valid" CHECK ("messages"."role" in ('user', 'assistant')),
	CONSTRAINT "messages_content_len" CHECK (char_length("messages"."content") between 1 and 100000),
	CONSTRAINT "messages_mode_valid" CHECK ("messages"."mode" is null or "messages"."mode" in ('explain_simply', 'step_by_step', 'example', 'hint', 'test_me', 'summarize', 'find_mistake', 'follow_up'))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversations"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_user_recent_idx" ON "conversations" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE "conversations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "conversations_select_own" ON "conversations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "conversations"."user_id");--> statement-breakpoint
CREATE POLICY "conversations_insert_own" ON "conversations" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "conversations"."user_id");--> statement-breakpoint
CREATE POLICY "conversations_update_own" ON "conversations" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "conversations"."user_id") WITH CHECK ((select auth.uid()) = "conversations"."user_id");--> statement-breakpoint
CREATE POLICY "messages_select_own" ON "messages" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "messages"."user_id");--> statement-breakpoint
CREATE POLICY "messages_insert_own_user_role" ON "messages" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "messages"."user_id" and "messages"."role" = 'user');