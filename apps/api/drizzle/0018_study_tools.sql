CREATE TABLE "flashcard_decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"provider" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flashcard_decks_id_user_unique" UNIQUE("id","user_id"),
	CONSTRAINT "flashcard_decks_source_valid" CHECK ("flashcard_decks"."source_type" in ('notes', 'topic', 'manual')),
	CONSTRAINT "flashcard_decks_status_valid" CHECK ("flashcard_decks"."status" in ('generating', 'ready', 'error'))
);
--> statement-breakpoint
ALTER TABLE "flashcard_decks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "flashcards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"hint" text,
	"position" integer DEFAULT 0 NOT NULL,
	"ease_x100" integer DEFAULT 250 NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"repetitions" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flashcards_ease_range" CHECK ("flashcards"."ease_x100" between 130 and 400)
);
--> statement-breakpoint
ALTER TABLE "flashcards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mindmaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"source" jsonb NOT NULL,
	"size" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"error" text,
	"tree" jsonb,
	"node_count" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"model" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mindmaps_source_valid" CHECK ("mindmaps"."source_type" in ('notes', 'topic')),
	CONSTRAINT "mindmaps_size_valid" CHECK ("mindmaps"."size" in ('small', 'medium', 'large')),
	CONSTRAINT "mindmaps_status_valid" CHECK ("mindmaps"."status" in ('generating', 'ready', 'error'))
);
--> statement-breakpoint
ALTER TABLE "mindmaps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flashcard_decks" ADD CONSTRAINT "flashcard_decks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_deck_owner_fk" FOREIGN KEY ("deck_id","user_id") REFERENCES "public"."flashcard_decks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mindmaps" ADD CONSTRAINT "mindmaps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flashcard_decks_user_created_idx" ON "flashcard_decks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "flashcards_deck_idx" ON "flashcards" USING btree ("deck_id","position");--> statement-breakpoint
CREATE INDEX "flashcards_user_due_idx" ON "flashcards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "mindmaps_user_created_idx" ON "mindmaps" USING btree ("user_id","created_at");--> statement-breakpoint
-- Server-only tables (the API scopes every query by the verified user id): no client role may touch them.
REVOKE ALL ON TABLE "public"."flashcard_decks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."flashcard_decks" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."flashcards" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."flashcards" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."mindmaps" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."mindmaps" FROM authenticated;
