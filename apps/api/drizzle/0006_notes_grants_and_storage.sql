-- Additive only: privileges on the two NEW tables, one trigger, extra column grants on two existing
-- tables (new columns only), a PRIVATE storage bucket and owner-only storage policies.
-- Nothing is dropped, truncated, deleted or rewritten.

-- 1) documents: students read their own rows and may edit only title / soft-delete flag / activity stamp.
--    The processing lifecycle (status, counts, errors) and the file location are written by the API server.
REVOKE ALL ON TABLE "public"."documents" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."documents" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."documents" TO authenticated;--> statement-breakpoint
GRANT UPDATE ("title", "deleted_at", "last_activity_at") ON TABLE "public"."documents" TO authenticated;--> statement-breakpoint
CREATE TRIGGER "documents_set_updated_at"
BEFORE UPDATE ON "public"."documents"
FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();--> statement-breakpoint

-- 2) document_chunks: read-only for students (the extracted text is derived data written by the server).
REVOKE ALL ON TABLE "public"."document_chunks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."document_chunks" FROM authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "public"."document_chunks" TO authenticated;--> statement-breakpoint

-- 3) New columns on existing tables: let the student-scoped API session set them on its own rows.
--    (Existing grants are untouched; metadata stays server-only.)
GRANT INSERT ("document_id") ON TABLE "public"."conversations" TO authenticated;--> statement-breakpoint
GRANT INSERT ("action") ON TABLE "public"."messages" TO authenticated;--> statement-breakpoint

-- 4) Private storage bucket for the original files. public = false: no public URLs, ever.
--    Size and type limits are enforced by Storage itself as a second line of defence.
INSERT INTO "storage"."buckets" ("id", "name", "public", "file_size_limit", "allowed_mime_types")
VALUES ('notes', 'notes', false, 10485760, ARRAY['application/pdf', 'text/plain', 'text/markdown'])
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

-- 5) Storage RLS: a signed-in student can read and add objects ONLY inside their own folder
--    (<user_id>/...). No update and no delete policy exists, so objects are append-only and
--    nothing can be overwritten or removed through the Storage API by a student.
CREATE POLICY "notes_objects_select_own" ON "storage"."objects"
FOR SELECT TO authenticated
USING (bucket_id = 'notes' AND (storage.foldername(name))[1] = (select auth.uid())::text);--> statement-breakpoint
CREATE POLICY "notes_objects_insert_own" ON "storage"."objects"
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'notes' AND (storage.foldername(name))[1] = (select auth.uid())::text);
