-- Additive only: grants, two functions and two triggers. Nothing is dropped or truncated.

-- 1) Least privilege. Supabase grants ALL on new public tables to anon/authenticated by default.
--    Anonymous users get nothing; signed-in users may read their row and edit two columns.
--    INSERT is done by the signup trigger; DELETE only happens via ON DELETE CASCADE from auth.users.
REVOKE ALL ON TABLE "public"."student_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."student_profiles" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."student_profiles" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("display_name", "timezone") ON TABLE "public"."student_profiles" TO authenticated;--> statement-breakpoint

-- 2) Keep updated_at honest regardless of which client performs the update.
CREATE FUNCTION "public"."set_updated_at"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "student_profiles_set_updated_at"
BEFORE UPDATE ON "public"."student_profiles"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint

-- 3) Create the profile row whenever Supabase Auth creates a user (email signup now, OAuth later).
--    SECURITY DEFINER with an empty search_path; not callable by API clients.
CREATE FUNCTION "public"."handle_new_user"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO "public"."student_profiles" ("id", "display_name")
  VALUES (
    NEW.id,
    left(
      coalesce(
        nullif(btrim(NEW.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(NEW.raw_user_meta_data ->> 'name'), ''),
        'Student'
      ),
      80
    )
  )
  ON CONFLICT ("id") DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE TRIGGER "on_auth_user_created"
AFTER INSERT ON "auth"."users"
FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();--> statement-breakpoint

-- 4) Backfill any auth users that already exist (idempotent; none expected on a fresh project).
INSERT INTO "public"."student_profiles" ("id", "display_name")
SELECT u.id, left(coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''), 'Student'), 80)
FROM "auth"."users" u
ON CONFLICT ("id") DO NOTHING;
