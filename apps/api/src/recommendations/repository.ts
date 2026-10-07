import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";
import type { RepeatedFact, SourceFact, TutorFact } from "./engine.js";

/** The study plan facts the optional AI wording may mention. */
export interface PlanFact {
  examDate: string;
  minutesPerDay: number;
}

export interface Extras {
  repeated: RepeatedFact[];
  sources: SourceFact[];
  tutor: TutorFact[];
  plan: PlanFact | null;
}

/**
 * The few facts the Progress read does not already have. ONE statement, as the signed-in student (Row Level Security
 * applies), in the student's own timezone. Everything is aggregated in the database: no per-row follow-up queries.
 */
export interface ExtrasRepository {
  load(userId: string): Promise<Extras>;
}

interface Loaded {
  repeated: Array<{ topic: string; subject: string | null; questions: number }>;
  sources: Array<{ topic: string; document_id: string; title: string }>;
  tutor: Array<{ topic: string; subject: string | null; date: string }>;
  plan: { exam_date: string; minutes_per_day: number } | null;
}

export function createExtrasRepository(db: Database): ExtrasRepository {
  return {
    async load(userId) {
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ data: Loaded }>(sql`
          with prof as (
            select coalesce((select n.name from pg_timezone_names n where n.name = p.timezone limit 1), 'UTC') as tz
            from (select 1) one
            left join public.student_profiles p on p.id = ${userId}
          ),
          fin as (
            select t.id as attempt_id, t.quiz_id
            from public.quiz_attempts t
            where t.user_id = ${userId} and t.status in ('submitted', 'expired') and t.percentage is not null
          ),
          -- A question the student got wrong (or left unanswered) in two or more finished attempts.
          qmiss as (
            select q.id, q.topic, z.subject
            from fin f
            join public.quiz_questions q on q.quiz_id = f.quiz_id and q.user_id = ${userId}
            join public.quizzes z on z.id = f.quiz_id and z.user_id = ${userId}
            left join public.quiz_answers a on a.attempt_id = f.attempt_id and a.question_id = q.id
            where q.topic is not null
            group by q.id, q.topic, z.subject
            having count(*) filter (where a.is_correct is not true) >= 2
          ),
          rep as (
            select topic, max(subject) as subject, count(*)::int as questions from qmiss group by topic order by questions desc limit 60
          ),
          -- Notes the topic's quiz questions were made from (only a real link: the quiz was generated from that note).
          src as (
            select distinct q.topic, d.id as document_id, d.title
            from public.quiz_questions q
            join public.quiz_sources s on s.quiz_id = q.quiz_id and s.user_id = ${userId}
            join public.documents d on d.id = s.document_id and d.user_id = ${userId} and d.deleted_at is null
            where q.user_id = ${userId} and q.topic is not null
            limit 100
          ),
          tut as (
            select c.topic, c.subject, ((max(c.updated_at)) at time zone p.tz)::date::text as date
            from public.conversations c cross join prof p
            where c.user_id = ${userId} and c.deleted_at is null and c.topic is not null
            group by c.topic, c.subject, p.tz
            order by max(c.updated_at) desc limit 50
          ),
          pl as (
            select exam_date::text as exam_date, minutes_per_day from public.study_plans where user_id = ${userId} and status = 'active' limit 1
          )
          select jsonb_build_object(
            'repeated', coalesce((select jsonb_agg(to_jsonb(rep)) from rep), '[]'::jsonb),
            'sources', coalesce((select jsonb_agg(to_jsonb(src)) from src), '[]'::jsonb),
            'tutor', coalesce((select jsonb_agg(to_jsonb(tut)) from tut), '[]'::jsonb),
            'plan', (select to_jsonb(pl) from pl)
          ) as data`),
      );
      const d = [...rows][0]!.data;
      return {
        repeated: d.repeated.map((r) => ({ topic: r.topic, subject: r.subject, questions: r.questions })),
        sources: d.sources.map((s) => ({ topic: s.topic, documentId: s.document_id, title: s.title })),
        tutor: d.tutor.map((t) => ({ topic: t.topic, subject: t.subject, date: t.date })),
        plan: d.plan ? { examDate: d.plan.exam_date, minutesPerDay: d.plan.minutes_per_day } : null,
      };
    },
  };
}
