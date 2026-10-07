import { sql } from "drizzle-orm";
import type { ActivityType, PlanStatus, SessionStatus } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { withUser } from "../db/with-user.js";
import type { AttemptFact, BreakdownFact, LastViva, RecentSessionFact, SessionFact, VivaFact } from "./compute.js";

export interface ProgressQuery {
  /** The current instant; the student's local "today" is worked out from it in their own timezone. */
  now: Date;
  /** Length of the period in days (null = all time). The period before it is read too, for the comparison. */
  rangeDays: number | null;
  /** Also read the latest events for the "Recent activity" list. */
  recent: boolean;
}

export interface ProgressData {
  sessions: SessionFact[];
  /** Every local day with a completed session, all time (for streaks). */
  studyDates: string[];
  /** Finished attempts in the period AND the period before it (for the comparison). */
  attempts: AttemptFact[];
  /** Question results of the finished attempts in the period only. */
  breakdown: BreakdownFact[];
  quizzesAttempted: number;
  recentSessions: RecentSessionFact[];
  recentAttempts: AttemptFact[];
  /** Vivas completed in the period (kept apart from quizzes). */
  viva: VivaFact[];
  lastViva: LastViva | null;
}

/**
 * Read-only access to the numbers behind Progress.
 *
 * ONE statement reads everything the page needs, as the signed-in student (Row Level Security applies to it).
 * The database here is reached over a network where every round trip costs time (and a parameterised query
 * cannot be pipelined), so one statement is the difference between ~1 second and ~2.5 seconds. Inside it each
 * part is a lean column list or an aggregate filtered to the period - there is no per-row follow-up work.
 *
 * "Today" and every date are decided IN THE DATABASE in the student's own timezone (`AT TIME ZONE`), and the
 * statement hands the timezone and today back so the rest of the code uses exactly the same ones - UTC dates
 * are never mixed with local ones.
 */
export interface ProgressRepository {
  load(userId: string, query: ProgressQuery): Promise<{ timezone: string; today: string; data: ProgressData }>;
}

/** An unknown timezone name would make the database reject the statement; the SQL falls back to UTC the same way. */
export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const RECENT_LIMIT = 12;

interface AttemptRow {
  attempt_id: string;
  quiz_id: string;
  title: string;
  subject: string | null;
  at: string;
  date: string;
  percentage: number;
}
interface Loaded {
  timezone: string;
  today: string;
  sessions: Array<{ id: string; date: string; completed_date: string | null; status: string; duration_minutes: number; subject: string; topic: string; activity_type: string; plan_status: string }>;
  study_dates: string[];
  attempts: AttemptRow[];
  breakdown: Array<{ attempt_id: string; topic: string | null; difficulty: string; total: number; answered: number; correct: number }>;
  attempted: number;
  recent_sessions: Array<{ id: string; status: string; at: string; date: string; subject: string; topic: string; duration_minutes: number }>;
  recent_attempts: AttemptRow[];
  viva: Array<{ id: string; subject: string; topic: string | null; score: number; date: string; at: string; c: number | null; p: number | null; l: number | null; f: number | null }>;
  last_viva: { subject: string; topic: string | null; score: number; total: number } | null;
}

const toAttempt = (r: AttemptRow): AttemptFact => ({ attemptId: r.attempt_id, quizId: r.quiz_id, quizTitle: r.title, subject: r.subject, at: new Date(r.at), date: r.date, percentage: Number(r.percentage) });

export function createProgressRepository(db: Database): ProgressRepository {
  return {
    async load(userId, q) {
      const days = q.rangeDays;
      const rows = await withUser(db, userId, (tx) =>
        tx.execute<{ data: Loaded }>(sql`
          with prof as (
            select coalesce((select n.name from pg_timezone_names n where n.name = p.timezone limit 1), 'UTC') as tz
            from (select 1) one
            left join public.student_profiles p on p.id = ${userId}
          ),
          b as (
            select tz, ((${q.now.toISOString()}::timestamptz) at time zone tz)::date as today
            from prof
          ),
          w as (
            select tz, today,
                   case when ${days}::int is null then null else today - (${days}::int - 1) end as from_d,
                   case when ${days}::int is null then null else today - (2 * ${days}::int - 1) end as since_d
            from b
          ),
          sess as (
            select s.id, s.scheduled_date::text as date, (s.completed_at at time zone w.tz)::date::text as completed_date,
                   s.status, s.duration_minutes, s.subject, s.topic, s.activity_type, p.status as plan_status
            from public.study_sessions s
            join public.study_plans p on p.id = s.plan_id and p.user_id = s.user_id
            cross join w
            where s.user_id = ${userId} and s.status <> 'rescheduled'
              and (w.since_d is null or s.scheduled_date >= w.since_d or (s.completed_at at time zone w.tz)::date >= w.since_d)
          ),
          dates as (
            select distinct (s.completed_at at time zone w.tz)::date::text as d
            from public.study_sessions s cross join w
            where s.user_id = ${userId} and s.status = 'completed'
          ),
          fin as (
            select t.id as attempt_id, t.quiz_id, z.title, z.subject, t.submitted_at as at,
                   (t.submitted_at at time zone w.tz)::date as local_day, t.percentage::float8 as percentage
            from public.quiz_attempts t
            join public.quizzes z on z.id = t.quiz_id and z.user_id = t.user_id
            cross join w
            where t.user_id = ${userId} and t.status in ('submitted', 'expired') and t.percentage is not null
          ),
          att as (
            select fin.attempt_id, fin.quiz_id, fin.title, fin.subject, fin.at, fin.local_day::text as date, fin.percentage
            from fin cross join w
            where w.since_d is null or fin.local_day >= w.since_d
          ),
          -- Each finished attempt covers every question of its quiz; a question without an answer is not correct.
          brk as (
            select t.attempt_id, q.topic, q.difficulty, count(*)::int as total, count(a.id)::int as answered,
                   (count(*) filter (where a.is_correct))::int as correct
            from fin t
            cross join w
            join public.quiz_questions q on q.quiz_id = t.quiz_id and q.user_id = ${userId}
            left join public.quiz_answers a on a.attempt_id = t.attempt_id and a.question_id = q.id
            where w.from_d is null or t.local_day >= w.from_d
            group by t.attempt_id, q.topic, q.difficulty
          ),
          started as (
            select count(distinct a.quiz_id)::int as n
            from public.quiz_attempts a cross join w
            where a.user_id = ${userId}
              and (w.from_d is null or (a.started_at at time zone w.tz)::date >= w.from_d)
              and (a.started_at at time zone w.tz)::date <= w.today
          ),
          vv as (
            select v.id, v.subject, v.topic, v.score::float8 as score, (v.completed_at at time zone w.tz)::date::text as date, v.completed_at as at,
                   avg(a.correctness)::float8 as c, avg(a.completeness)::float8 as p, avg(a.clarity)::float8 as l, avg(a.confidence)::float8 as f
            from public.viva_sessions v
            cross join w
            left join public.viva_answers a on a.session_id = v.id
            where v.user_id = ${userId} and v.status = 'completed'
              and (w.from_d is null or (v.completed_at at time zone w.tz)::date >= w.from_d)
            group by v.id, w.tz
          ),
          lv as (
            select l.subject, l.topic, l.score::float8 as score, (select count(*)::int from public.viva_sessions t where t.user_id = ${userId} and t.status = 'completed') as total
            from public.viva_sessions l
            where l.user_id = ${userId} and l.status = 'completed'
            order by l.completed_at desc limit 1
          ),
          rs as (
            select s.id, s.status, (case when s.status = 'completed' then s.completed_at else s.updated_at end) as at,
                   ((case when s.status = 'completed' then s.completed_at else s.updated_at end) at time zone w.tz)::date::text as date,
                   s.subject, s.topic, s.duration_minutes
            from public.study_sessions s cross join w
            where ${q.recent}::boolean and s.user_id = ${userId} and s.status in ('completed', 'skipped')
            order by 3 desc limit ${RECENT_LIMIT}
          ),
          ra as (
            select attempt_id, quiz_id, title, subject, at, local_day::text as date, percentage
            from fin where ${q.recent}::boolean order by at desc limit ${RECENT_LIMIT}
          )
          select jsonb_build_object(
            'timezone', (select tz from w),
            'today', (select today::text from w),
            'sessions', coalesce((select jsonb_agg(to_jsonb(sess)) from sess), '[]'::jsonb),
            'study_dates', coalesce((select jsonb_agg(d order by d) from dates), '[]'::jsonb),
            'attempts', coalesce((select jsonb_agg(to_jsonb(att) order by att.at) from att), '[]'::jsonb),
            'breakdown', coalesce((select jsonb_agg(to_jsonb(brk)) from brk), '[]'::jsonb),
            'attempted', (select n from started),
            'recent_sessions', coalesce((select jsonb_agg(to_jsonb(rs) order by rs.at desc) from rs), '[]'::jsonb),
            'recent_attempts', coalesce((select jsonb_agg(to_jsonb(ra) order by ra.at desc) from ra), '[]'::jsonb),
            'viva', coalesce((select jsonb_agg(to_jsonb(vv) order by vv.at) from vv), '[]'::jsonb),
            'last_viva', (select to_jsonb(lv) from lv)
          ) as data`),
      );
      const d = [...rows][0]!.data;
      return {
        timezone: d.timezone,
        today: d.today,
        data: {
          sessions: d.sessions.map((r) => ({
            id: r.id,
            date: r.date,
            completedDate: r.completed_date,
            status: r.status as SessionStatus,
            durationMinutes: r.duration_minutes,
            subject: r.subject,
            topic: r.topic,
            activityType: r.activity_type as ActivityType,
            planStatus: r.plan_status as PlanStatus,
          })),
          studyDates: d.study_dates,
          attempts: d.attempts.map(toAttempt),
          breakdown: d.breakdown.map((r) => ({ attemptId: r.attempt_id, topic: r.topic, difficulty: r.difficulty as BreakdownFact["difficulty"], total: r.total, answered: r.answered, correct: r.correct })),
          quizzesAttempted: d.attempted ?? 0,
          recentSessions: d.recent_sessions.map((r) => ({ id: r.id, status: r.status as "completed" | "skipped", at: new Date(r.at), date: r.date, subject: r.subject, topic: r.topic, durationMinutes: r.duration_minutes })),
          recentAttempts: d.recent_attempts.map(toAttempt),
          viva: d.viva.map((r) => ({ id: r.id, subject: r.subject, topic: r.topic, score: Number(r.score), date: r.date, at: new Date(r.at), c: r.c, p: r.p, l: r.l, f: r.f })),
          lastViva: d.last_viva ? { subject: d.last_viva.subject, topic: d.last_viva.topic, score: Number(d.last_viva.score), total: d.last_viva.total } : null,
        },
      };
    },
  };
}
