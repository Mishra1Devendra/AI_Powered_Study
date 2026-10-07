CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_len" CHECK (char_length("audit_log"."action") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"page" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "bug_reports_status_valid" CHECK ("bug_reports"."status" in ('open', 'resolved')),
	CONSTRAINT "bug_reports_title_len" CHECK (char_length(btrim("bug_reports"."title")) between 3 and 120),
	CONSTRAINT "bug_reports_description_len" CHECK (char_length(btrim("bug_reports"."description")) between 10 and 2000)
);
--> statement-breakpoint
ALTER TABLE "bug_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bug_reports_created_idx" ON "bug_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bug_reports_user_created_idx" ON "bug_reports" USING btree ("user_id","created_at");--> statement-breakpoint
-- Server-only tables: no client role may touch them (Supabase grants ALL on new public tables by default).
REVOKE ALL ON TABLE "public"."audit_log" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."audit_log" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."bug_reports" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."bug_reports" FROM authenticated;
