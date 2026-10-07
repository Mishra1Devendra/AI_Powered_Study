CREATE TABLE "session_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"questions" jsonb,
	"answers" jsonb,
	"score" integer,
	"error" text,
	"provider" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "session_checks_status_valid" CHECK ("session_checks"."status" in ('generating', 'ready', 'passed', 'failed', 'error')),
	CONSTRAINT "session_checks_score_range" CHECK ("session_checks"."score" is null or "session_checks"."score" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "session_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_checks" ADD CONSTRAINT "session_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_checks" ADD CONSTRAINT "session_checks_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."study_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_checks_session_created_idx" ON "session_checks" USING btree ("session_id","created_at");--> statement-breakpoint
-- Server-only table (it holds answer keys): no client role may touch it.
REVOKE ALL ON TABLE "public"."session_checks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."session_checks" FROM authenticated;
