-- Additive only: privileges on the five NEW quiz tables and one trigger. Nothing existing is
-- dropped, truncated, deleted or rewritten.
--
-- Principle: the students' database role (`authenticated`, i.e. what a student's own JWT gets if
-- it talks to PostgREST directly) may only READ its own quiz rows. Every write (generating a quiz,
-- saving answers, grading) is done by the API server. And the answer key is unreadable to students:
-- quiz_questions.correct_answer / explanation / source_ref are left out of the column-level SELECT
-- grant, so no query, however crafted, can reveal an answer before the API returns it after submission.

REVOKE ALL ON TABLE "public"."quizzes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."quizzes" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."quizzes" TO authenticated;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."quiz_sources" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."quiz_sources" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."quiz_sources" TO authenticated;--> statement-breakpoint

-- Questions: column-level SELECT without the answer key.
REVOKE ALL ON TABLE "public"."quiz_questions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."quiz_questions" FROM authenticated;--> statement-breakpoint
GRANT SELECT ("id", "quiz_id", "user_id", "question_order", "question_type", "question_text", "options", "topic", "difficulty", "created_at")
ON TABLE "public"."quiz_questions" TO authenticated;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."quiz_attempts" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."quiz_attempts" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."quiz_attempts" TO authenticated;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."quiz_answers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."quiz_answers" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."quiz_answers" TO authenticated;--> statement-breakpoint

-- Keep quizzes.updated_at honest (same helper the other tables use).
CREATE TRIGGER "quizzes_set_updated_at"
BEFORE UPDATE ON "public"."quizzes"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
