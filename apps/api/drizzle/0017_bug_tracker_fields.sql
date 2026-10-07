ALTER TABLE "bug_reports" DROP CONSTRAINT "bug_reports_status_valid";--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "type" text DEFAULT 'bug' NOT NULL;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "severity" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_type_valid" CHECK ("bug_reports"."type" in ('bug', 'feature', 'other'));--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_severity_valid" CHECK ("bug_reports"."severity" in ('low', 'medium', 'high'));--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_status_valid" CHECK ("bug_reports"."status" in ('open', 'in_progress', 'resolved'));