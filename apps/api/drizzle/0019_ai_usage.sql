CREATE TABLE "ai_usage" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_user_id_day_pk" PRIMARY KEY("user_id","day"),
	CONSTRAINT "ai_usage_units_nonnegative" CHECK ("ai_usage"."units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Server-only: no client role may read or change an account's AI counter.
REVOKE ALL ON TABLE "public"."ai_usage" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."ai_usage" FROM authenticated;
