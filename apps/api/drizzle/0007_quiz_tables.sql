CREATE TABLE "quiz_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"selected_answer" integer NOT NULL,
	"is_correct" boolean,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_answers_attempt_question_key" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "quiz_answers_selected_valid" CHECK ("quiz_answers"."selected_answer" between 0 and 9)
);
--> statement-breakpoint
ALTER TABLE "quiz_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"question_order" uuid[] NOT NULL,
	"score" integer,
	"total" integer,
	"percentage" numeric(5, 2),
	"time_taken_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempts_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "quiz_attempts_id_quiz_key" UNIQUE("id","quiz_id"),
	CONSTRAINT "quiz_attempts_status_valid" CHECK ("quiz_attempts"."status" in ('in_progress', 'submitted', 'expired')),
	CONSTRAINT "quiz_attempts_submitted_consistent" CHECK (("quiz_attempts"."status" = 'in_progress') = ("quiz_attempts"."submitted_at" is null)),
	CONSTRAINT "quiz_attempts_score_valid" CHECK ("quiz_attempts"."score" is null or ("quiz_attempts"."total" is not null and "quiz_attempts"."score" between 0 and "quiz_attempts"."total")),
	CONSTRAINT "quiz_attempts_percentage_valid" CHECK ("quiz_attempts"."percentage" is null or "quiz_attempts"."percentage" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_order" integer NOT NULL,
	"question_type" text NOT NULL,
	"question_text" text NOT NULL,
	"options" jsonb,
	"correct_answer" jsonb NOT NULL,
	"explanation" text NOT NULL,
	"topic" text,
	"difficulty" text NOT NULL,
	"source_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_questions_id_quiz_key" UNIQUE("id","quiz_id"),
	CONSTRAINT "quiz_questions_order_key" UNIQUE("quiz_id","question_order"),
	CONSTRAINT "quiz_questions_type_valid" CHECK ("quiz_questions"."question_type" in ('mcq', 'true_false', 'short_answer', 'numerical')),
	CONSTRAINT "quiz_questions_order_valid" CHECK ("quiz_questions"."question_order" >= 0),
	CONSTRAINT "quiz_questions_text_len" CHECK (char_length(btrim("quiz_questions"."question_text")) between 1 and 1000),
	CONSTRAINT "quiz_questions_explanation_len" CHECK (char_length(btrim("quiz_questions"."explanation")) between 1 and 1500),
	CONSTRAINT "quiz_questions_difficulty_valid" CHECK ("quiz_questions"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "quiz_questions_topic_len" CHECK ("quiz_questions"."topic" is null or char_length("quiz_questions"."topic") between 1 and 100),
	CONSTRAINT "quiz_questions_options_shape" CHECK (("quiz_questions"."question_type" in ('mcq', 'true_false') and jsonb_typeof("quiz_questions"."options") = 'array' and jsonb_array_length("quiz_questions"."options") between 2 and 6) or ("quiz_questions"."question_type" in ('short_answer', 'numerical') and "quiz_questions"."options" is null)),
	CONSTRAINT "quiz_questions_choice_answer_is_index" CHECK ("quiz_questions"."question_type" not in ('mcq', 'true_false') or jsonb_typeof("quiz_questions"."correct_answer") = 'number')
);
--> statement-breakpoint
ALTER TABLE "quiz_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_sources" (
	"quiz_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "quiz_sources_pkey" PRIMARY KEY("quiz_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"subject" text,
	"topic" text,
	"focus" text,
	"difficulty" text NOT NULL,
	"question_count" integer NOT NULL,
	"question_types" text[] NOT NULL,
	"time_limit_minutes" integer,
	"status" text DEFAULT 'generating' NOT NULL,
	"generation_error" text,
	"provider" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "quizzes_title_len" CHECK (char_length(btrim("quizzes"."title")) between 1 and 200),
	CONSTRAINT "quizzes_source_type_valid" CHECK ("quizzes"."source_type" in ('notes', 'topic')),
	CONSTRAINT "quizzes_topic_source_has_subject" CHECK ("quizzes"."source_type" <> 'topic' or "quizzes"."subject" is not null),
	CONSTRAINT "quizzes_difficulty_valid" CHECK ("quizzes"."difficulty" in ('easy', 'medium', 'hard', 'mixed')),
	CONSTRAINT "quizzes_question_count_valid" CHECK ("quizzes"."question_count" between 1 and 50),
	CONSTRAINT "quizzes_question_types_valid" CHECK (cardinality("quizzes"."question_types") >= 1 and "quizzes"."question_types" <@ array['mcq', 'true_false', 'short_answer', 'numerical']),
	CONSTRAINT "quizzes_time_limit_valid" CHECK ("quizzes"."time_limit_minutes" is null or "quizzes"."time_limit_minutes" between 1 and 180),
	CONSTRAINT "quizzes_status_valid" CHECK ("quizzes"."status" in ('generating', 'ready', 'failed')),
	CONSTRAINT "quizzes_error_len" CHECK ("quizzes"."generation_error" is null or char_length("quizzes"."generation_error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_attempt_owner_fk" FOREIGN KEY ("attempt_id","user_id") REFERENCES "public"."quiz_attempts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_attempt_quiz_fk" FOREIGN KEY ("attempt_id","quiz_id") REFERENCES "public"."quiz_attempts"("id","quiz_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_question_quiz_fk" FOREIGN KEY ("question_id","quiz_id") REFERENCES "public"."quiz_questions"("id","quiz_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_owner_fk" FOREIGN KEY ("quiz_id","user_id") REFERENCES "public"."quizzes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_owner_fk" FOREIGN KEY ("quiz_id","user_id") REFERENCES "public"."quizzes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_sources" ADD CONSTRAINT "quiz_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_sources" ADD CONSTRAINT "quiz_sources_quiz_owner_fk" FOREIGN KEY ("quiz_id","user_id") REFERENCES "public"."quizzes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_sources" ADD CONSTRAINT "quiz_sources_document_owner_fk" FOREIGN KEY ("document_id","user_id") REFERENCES "public"."documents"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_answers_user_idx" ON "quiz_answers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_answers_question_idx" ON "quiz_answers" USING btree ("question_id","quiz_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_one_open_key" ON "quiz_attempts" USING btree ("quiz_id","user_id") WHERE "quiz_attempts"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_recent_idx" ON "quiz_attempts" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quiz_attempts_quiz_idx" ON "quiz_attempts" USING btree ("quiz_id","user_id");--> statement-breakpoint
CREATE INDEX "quiz_sources_document_idx" ON "quiz_sources" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE INDEX "quizzes_user_recent_idx" ON "quizzes" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "quiz_answers_select_own" ON "quiz_answers" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "quiz_answers"."user_id");--> statement-breakpoint
CREATE POLICY "quiz_attempts_select_own" ON "quiz_attempts" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "quiz_attempts"."user_id");--> statement-breakpoint
CREATE POLICY "quiz_questions_select_own" ON "quiz_questions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "quiz_questions"."user_id");--> statement-breakpoint
CREATE POLICY "quiz_sources_select_own" ON "quiz_sources" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "quiz_sources"."user_id");--> statement-breakpoint
CREATE POLICY "quizzes_select_own" ON "quizzes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "quizzes"."user_id");