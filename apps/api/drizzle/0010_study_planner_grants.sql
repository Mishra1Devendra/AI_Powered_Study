-- Additive only: privileges on the two NEW study planner tables and their updated_at triggers.
-- Nothing existing is dropped, truncated, deleted or rewritten.
--
-- Students (the `authenticated` role, i.e. a student's own JWT talking to PostgREST directly) may only
-- READ their own planner rows (RLS policies from 0009). Every write - generating a plan, starting,
-- completing, skipping or rescheduling a session - goes through the API server, which validates it.

REVOKE ALL ON TABLE "public"."study_plans" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."study_plans" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."study_plans" TO authenticated;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."study_sessions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."study_sessions" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."study_sessions" TO authenticated;--> statement-breakpoint

CREATE TRIGGER "study_plans_set_updated_at"
BEFORE UPDATE ON "public"."study_plans"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "study_sessions_set_updated_at"
BEFORE UPDATE ON "public"."study_sessions"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
