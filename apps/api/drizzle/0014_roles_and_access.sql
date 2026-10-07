ALTER TABLE "student_profiles" ADD COLUMN "role" text DEFAULT 'student' NOT NULL;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD COLUMN "access_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD COLUMN "access_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD COLUMN "access_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_role_valid" CHECK ("student_profiles"."role" in ('student', 'admin'));--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_access_status_valid" CHECK ("student_profiles"."access_status" in ('active', 'revoked'));