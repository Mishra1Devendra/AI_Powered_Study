-- Additive only: privileges on the two NEW tables, plus two triggers. No existing table is altered.

-- 1) Least privilege. Supabase grants ALL on new public tables to anon/authenticated by default.
--    Anonymous users get nothing. Signed-in users:
--      conversations: read, create, and edit only title/context/soft-delete flag. NO hard DELETE.
--      messages:      read, and insert user messages. NO UPDATE and NO DELETE (append-only).
--    Assistant messages are written by the API server (privileged connection), never by clients.
REVOKE ALL ON TABLE "public"."conversations" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."conversations" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."messages" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."messages" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."conversations" TO authenticated;--> statement-breakpoint
GRANT INSERT ("user_id", "title", "subject", "topic", "level") ON TABLE "public"."conversations" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("title", "subject", "topic", "level", "deleted_at") ON TABLE "public"."conversations" TO authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."messages" TO authenticated;--> statement-breakpoint
GRANT INSERT ("conversation_id", "user_id", "role", "content", "mode") ON TABLE "public"."messages" TO authenticated;--> statement-breakpoint

-- 2) Keep conversations.updated_at honest on edits (reuses the function from migration 0001).
CREATE TRIGGER "conversations_set_updated_at"
BEFORE UPDATE ON "public"."conversations"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint

-- 3) Bump the conversation's updated_at whenever a message is added, so "recent" ordering works.
--    SECURITY DEFINER with an empty search_path; not callable by API clients.
CREATE FUNCTION "public"."touch_conversation_on_message"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE "public"."conversations" SET "updated_at" = now() WHERE "id" = NEW."conversation_id";
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."touch_conversation_on_message"() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE TRIGGER "messages_touch_conversation"
AFTER INSERT ON "public"."messages"
FOR EACH ROW EXECUTE FUNCTION "public"."touch_conversation_on_message"();
