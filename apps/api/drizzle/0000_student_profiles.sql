CREATE TABLE "student_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_profiles_display_name_len" CHECK (char_length(btrim("student_profiles"."display_name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "student_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "student_profiles_select_own" ON "student_profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "student_profiles"."id");--> statement-breakpoint
CREATE POLICY "student_profiles_update_own" ON "student_profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "student_profiles"."id") WITH CHECK ((select auth.uid()) = "student_profiles"."id");