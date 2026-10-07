-- Additive only: privileges on the three NEW viva tables and their updated_at trigger.
-- Nothing existing is dropped, truncated, deleted or rewritten.
--
-- Students (the `authenticated` role, i.e. a student's own JWT talking to PostgREST directly) may only READ their own
-- rows (RLS policies from 0011). Every write - starting a viva, saving a question, evaluating an answer, completing
-- or abandoning - goes through the API server, which validates it.

REVOKE ALL ON TABLE "public"."viva_sessions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."viva_sessions" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."viva_sessions" TO authenticated;--> statement-breakpoint

-- Questions: column-level SELECT WITHOUT key_points (what a strong answer covers), so even a direct PostgREST call with a
-- valid student token cannot read the examiner's expected points before the question has been answered.
REVOKE ALL ON TABLE "public"."viva_questions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."viva_questions" FROM authenticated;--> statement-breakpoint
GRANT SELECT ("id", "session_id", "user_id", "question_number", "question_text", "concept", "is_follow_up", "created_at")
ON TABLE "public"."viva_questions" TO authenticated;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."viva_answers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."viva_answers" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."viva_answers" TO authenticated;--> statement-breakpoint

-- Keep viva_sessions.updated_at honest (same helper the other tables use).
CREATE TRIGGER "viva_sessions_set_updated_at"
BEFORE UPDATE ON "public"."viva_sessions"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
