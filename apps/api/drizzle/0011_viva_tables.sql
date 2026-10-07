CREATE TABLE "viva_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"answer_text" text NOT NULL,
	"correctness" smallint NOT NULL,
	"completeness" smallint NOT NULL,
	"clarity" smallint NOT NULL,
	"confidence" smallint NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"feedback" text NOT NULL,
	"missing_concepts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"should_follow_up" boolean DEFAULT false NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viva_answers_question_key" UNIQUE("question_id"),
	CONSTRAINT "viva_answers_text_len" CHECK (char_length(btrim("viva_answers"."answer_text")) between 1 and 3000),
	CONSTRAINT "viva_answers_scores_valid" CHECK ("viva_answers"."correctness" between 0 and 10 and "viva_answers"."completeness" between 0 and 10 and "viva_answers"."clarity" between 0 and 10 and "viva_answers"."confidence" between 0 and 10),
	CONSTRAINT "viva_answers_score_valid" CHECK ("viva_answers"."score" between 0 and 100),
	CONSTRAINT "viva_answers_feedback_len" CHECK (char_length("viva_answers"."feedback") between 1 and 1500),
	CONSTRAINT "viva_answers_missing_valid" CHECK (jsonb_typeof("viva_answers"."missing_concepts") = 'array' and jsonb_array_length("viva_answers"."missing_concepts") <= 6)
);
--> statement-breakpoint
ALTER TABLE "viva_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "viva_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_number" integer NOT NULL,
	"question_text" text NOT NULL,
	"concept" text NOT NULL,
	"key_points" jsonb NOT NULL,
	"is_follow_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viva_questions_id_session_key" UNIQUE("id","session_id"),
	CONSTRAINT "viva_questions_number_key" UNIQUE("session_id","question_number"),
	CONSTRAINT "viva_questions_number_valid" CHECK ("viva_questions"."question_number" between 1 and 15),
	CONSTRAINT "viva_questions_text_len" CHECK (char_length(btrim("viva_questions"."question_text")) between 1 and 600),
	CONSTRAINT "viva_questions_concept_len" CHECK (char_length(btrim("viva_questions"."concept")) between 1 and 80),
	CONSTRAINT "viva_questions_key_points_valid" CHECK (jsonb_typeof("viva_questions"."key_points") = 'array' and jsonb_array_length("viva_questions"."key_points") between 1 and 6)
);
--> statement-breakpoint
ALTER TABLE "viva_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "viva_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"topic" text,
	"difficulty" text NOT NULL,
	"question_count" integer NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"score" numeric(5, 2),
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viva_sessions_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "viva_sessions_subject_len" CHECK (char_length(btrim("viva_sessions"."subject")) between 1 and 100),
	CONSTRAINT "viva_sessions_topic_len" CHECK ("viva_sessions"."topic" is null or char_length(btrim("viva_sessions"."topic")) between 1 and 100),
	CONSTRAINT "viva_sessions_difficulty_valid" CHECK ("viva_sessions"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "viva_sessions_question_count_valid" CHECK ("viva_sessions"."question_count" between 3 and 15),
	CONSTRAINT "viva_sessions_status_valid" CHECK ("viva_sessions"."status" in ('in_progress', 'completed', 'abandoned')),
	CONSTRAINT "viva_sessions_score_valid" CHECK ("viva_sessions"."score" is null or "viva_sessions"."score" between 0 and 100),
	CONSTRAINT "viva_sessions_completed_consistent" CHECK (("viva_sessions"."status" = 'completed') = ("viva_sessions"."completed_at" is not null and "viva_sessions"."score" is not null))
);
--> statement-breakpoint
ALTER TABLE "viva_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "viva_answers" ADD CONSTRAINT "viva_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viva_answers" ADD CONSTRAINT "viva_answers_question_session_fk" FOREIGN KEY ("question_id","session_id") REFERENCES "public"."viva_questions"("id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viva_answers" ADD CONSTRAINT "viva_answers_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."viva_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viva_questions" ADD CONSTRAINT "viva_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viva_questions" ADD CONSTRAINT "viva_questions_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."viva_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viva_sessions" ADD CONSTRAINT "viva_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viva_answers_session_idx" ON "viva_answers" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "viva_sessions_user_recent_idx" ON "viva_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "viva_answers_select_own" ON "viva_answers" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "viva_answers"."user_id");--> statement-breakpoint
CREATE POLICY "viva_questions_select_own" ON "viva_questions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "viva_questions"."user_id");--> statement-breakpoint
CREATE POLICY "viva_sessions_select_own" ON "viva_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "viva_sessions"."user_id");