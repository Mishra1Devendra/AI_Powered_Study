CREATE TABLE "study_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"exam_date" date NOT NULL,
	"start_date" date NOT NULL,
	"target_score" integer,
	"minutes_per_day" integer NOT NULL,
	"knowledge_level" text NOT NULL,
	"study_days" integer[] NOT NULL,
	"preferred_time" text DEFAULT 'any' NOT NULL,
	"subjects" jsonb NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"generation_error" text,
	"summary" text,
	"unscheduled_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weak_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_plans_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "study_plans_title_len" CHECK (char_length(btrim("study_plans"."title")) between 1 and 100),
	CONSTRAINT "study_plans_dates_valid" CHECK ("study_plans"."exam_date" > "study_plans"."start_date" and "study_plans"."exam_date" <= "study_plans"."start_date" + 366),
	CONSTRAINT "study_plans_target_valid" CHECK ("study_plans"."target_score" is null or "study_plans"."target_score" between 0 and 100),
	CONSTRAINT "study_plans_minutes_valid" CHECK ("study_plans"."minutes_per_day" between 15 and 480),
	CONSTRAINT "study_plans_level_valid" CHECK ("study_plans"."knowledge_level" in ('beginner', 'intermediate', 'advanced')),
	CONSTRAINT "study_plans_days_valid" CHECK (cardinality("study_plans"."study_days") between 1 and 7 and "study_plans"."study_days" <@ array[1, 2, 3, 4, 5, 6, 7]),
	CONSTRAINT "study_plans_time_valid" CHECK ("study_plans"."preferred_time" in ('morning', 'afternoon', 'evening', 'any')),
	CONSTRAINT "study_plans_subjects_valid" CHECK (jsonb_typeof("study_plans"."subjects") = 'array' and jsonb_array_length("study_plans"."subjects") between 1 and 8),
	CONSTRAINT "study_plans_status_valid" CHECK ("study_plans"."status" in ('generating', 'active', 'archived', 'failed')),
	CONSTRAINT "study_plans_error_len" CHECK ("study_plans"."generation_error" is null or char_length("study_plans"."generation_error") <= 500),
	CONSTRAINT "study_plans_summary_len" CHECK ("study_plans"."summary" is null or char_length("study_plans"."summary") <= 600)
);
--> statement-breakpoint
ALTER TABLE "study_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_date" date NOT NULL,
	"start_time" time,
	"duration_minutes" integer NOT NULL,
	"subject" text NOT NULL,
	"topic" text NOT NULL,
	"activity_type" text NOT NULL,
	"priority" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"rescheduled_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_sessions_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "study_sessions_duration_valid" CHECK ("study_sessions"."duration_minutes" between 5 and 240),
	CONSTRAINT "study_sessions_subject_len" CHECK (char_length(btrim("study_sessions"."subject")) between 1 and 60),
	CONSTRAINT "study_sessions_topic_len" CHECK (char_length(btrim("study_sessions"."topic")) between 1 and 120),
	CONSTRAINT "study_sessions_activity_valid" CHECK ("study_sessions"."activity_type" in ('learn', 'practice', 'quiz', 'revision', 'mock_test')),
	CONSTRAINT "study_sessions_priority_valid" CHECK ("study_sessions"."priority" in ('high', 'medium', 'low')),
	CONSTRAINT "study_sessions_status_valid" CHECK ("study_sessions"."status" in ('planned', 'in_progress', 'completed', 'skipped', 'missed', 'rescheduled')),
	CONSTRAINT "study_sessions_completed_consistent" CHECK (("study_sessions"."status" = 'completed') = ("study_sessions"."completed_at" is not null)),
	CONSTRAINT "study_sessions_notes_len" CHECK ("study_sessions"."notes" is null or char_length("study_sessions"."notes") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "study_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "study_plans" ADD CONSTRAINT "study_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_plan_owner_fk" FOREIGN KEY ("plan_id","user_id") REFERENCES "public"."study_plans"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_rescheduled_from_fk" FOREIGN KEY ("rescheduled_from_id","user_id") REFERENCES "public"."study_sessions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "study_plans_one_active_key" ON "study_plans" USING btree ("user_id") WHERE "study_plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "study_plans_user_recent_idx" ON "study_plans" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "study_sessions_plan_date_idx" ON "study_sessions" USING btree ("plan_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "study_sessions_user_date_idx" ON "study_sessions" USING btree ("user_id","scheduled_date");--> statement-breakpoint
CREATE POLICY "study_plans_select_own" ON "study_plans" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "study_plans"."user_id");--> statement-breakpoint
CREATE POLICY "study_sessions_select_own" ON "study_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "study_sessions"."user_id");