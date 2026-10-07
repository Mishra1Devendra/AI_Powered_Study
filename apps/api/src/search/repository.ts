import { sql } from "drizzle-orm";
import { SEARCH_LIMITS, searchResponseSchema, type SearchResponse } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";

/**
 * Global search = NAVIGATION, not question answering: it matches the words typed against titles, subjects and topics of the
 * student's OWN records. No AI model is involved and nothing is written. Every query filters on the verified user id and runs
 * under Row Level Security.
 */
export interface SearchRepository {
  search(userId: string, query: string): Promise<SearchResponse>;
}

/** Makes `%`, `_` and the escape character match literally. */
export const likePattern = (q: string) => `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;

export function createSearchRepository(db: Database): SearchRepository {
  return {
    async search(userId, query) {
      const p = likePattern(query);
      const n = SEARCH_LIMITS.perGroup;
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ data: unknown }>(sql`
          select jsonb_build_object(
            'documents', coalesce((select jsonb_agg(to_jsonb(x)) from (
              select id::text as id, title, original_filename as detail, '/notes/' || id::text as href
              from public.documents
              where user_id = ${userId} and deleted_at is null and processing_status = 'ready'
                and (title ilike ${p} escape '!' or original_filename ilike ${p} escape '!')
              order by last_activity_at desc limit ${n}) x), '[]'::jsonb),
            'quizzes', coalesce((select jsonb_agg(to_jsonb(x)) from (
              select id::text as id, title, nullif(concat_ws(' · ', subject, topic), '') as detail, '/quiz/' || id::text as href
              from public.quizzes
              where user_id = ${userId} and status = 'ready'
                and (title ilike ${p} escape '!' or subject ilike ${p} escape '!' or topic ilike ${p} escape '!')
              order by created_at desc limit ${n}) x), '[]'::jsonb),
            'plans', coalesce((select jsonb_agg(to_jsonb(x)) from (
              select id::text as id, title, 'Exam on ' || exam_date::text as detail, '/study-plan/' || id::text as href
              from public.study_plans
              where user_id = ${userId} and status in ('active', 'archived') and title ilike ${p} escape '!'
              order by created_at desc limit ${n}) x), '[]'::jsonb),
            'conversations', coalesce((select jsonb_agg(to_jsonb(x)) from (
              select id::text as id, title, nullif(concat_ws(' · ', subject, topic), '') as detail, '/tutor/' || id::text as href
              from public.conversations
              where user_id = ${userId} and deleted_at is null and document_id is null
                and (title ilike ${p} escape '!' or subject ilike ${p} escape '!' or topic ilike ${p} escape '!')
              order by updated_at desc limit ${n}) x), '[]'::jsonb),
            'topics', coalesce((select jsonb_agg(to_jsonb(t)) from (
              select subject, topic from (
                select subject, topic from public.quizzes where user_id = ${userId} and status = 'ready'
                union
                select subject, topic from public.conversations where user_id = ${userId} and deleted_at is null and document_id is null
                union
                select subject, topic from public.study_sessions where user_id = ${userId}
              ) u
              where (subject is not null or topic is not null) and (subject ilike ${p} escape '!' or topic ilike ${p} escape '!')
              group by subject, topic
              order by subject nulls last, topic nulls last
              limit ${n + 1}) t), '[]'::jsonb)
          ) as data`),
      );
      return searchResponseSchema.parse({ query, ...(rows[0]?.data as object) });
    },
  };
}
