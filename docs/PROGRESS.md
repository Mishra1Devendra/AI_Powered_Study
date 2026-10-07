# Progress & Analytics (Phase 8)

Route: `/progress`. Dashboard shows a compact "Your progress" snapshot (last 30 days) linking to it.
**No AI is involved anywhere**: every number is calculated by the API from the student's own completed study
sessions and finished quiz attempts. There are no new tables, columns, migrations or indexes.

## Where the data comes from (existing tables only)

| Need | Source |
| --- | --- |
| Study time, sessions, activity types, subjects | `study_sessions` (+ `study_plans.status`) |
| Quiz scores, accuracy, difficulty | `quiz_attempts`, `quiz_answers`, `quiz_questions`, `quizzes` |
| Timezone | `student_profiles.timezone` |

## Definitions (single source: `packages/shared/src/progress.ts`; maths: `apps/api/src/progress/compute.ts`)

- **Completed session**: status `completed` (the student pressed *Mark complete*). Planned, started, skipped,
  missed and rescheduled sessions are never completed.
- **Study time**: sum of the *planned length* of completed sessions (the app does not time sessions).
- **Study day**: a local calendar day with at least one completed session. The completion time decides the day.
- **Current streak**: consecutive study days ending today; a streak that ended yesterday is still alive (today is
  not over). Otherwise 0. With no study day at all the value is empty ("Not enough data yet"), never 0.
- **Longest streak**: longest run of consecutive study days, all time. Streaks ignore the date-range filter.
  Only completed sessions count: skipped-only days and planned sessions create no streak.
- **Completion rate**: completed / (completed + skipped + missed) in the period. Sessions still to come are shown
  separately and not counted. *Missed* = kept as missed, or planned/in-progress after its day - the second kind only
  for the **active** plan (a replaced plan's untouched sessions are not the student's misses). Rescheduled originals
  are history; the new session is counted where it was moved to.
- **Finished attempt**: status `submitted` or `expired`. In-progress attempts and quizzes that failed to generate
  never count.
- **Average quiz score**: mean of the percentage of finished attempts in the period.
- **Quiz / topic accuracy**: correct answers / questions over finished attempts. An unanswered question is not correct
  (same rule as the quiz score). Every attempt counts, so a retake counts its questions again.
- **Topic**: the question's own topic text (never invented; questions without one are left out of topic views).
  Names are merged ignoring capitalisation and spacing.
- **Insufficient data**: fewer than **5** questions. No percentage or label is shown.
- **Strong** >= **75%**, **Needs practice** 50-74%, **Weak** < **50%**. Documented cut-offs, not a validated measure
  of ability. No overall score is calculated. (The Study Planner uses the same "weak" definition.)
- **Improving topic**: the newest attempts (>= 3 questions) are at least **10 points** better than the earlier ones
  (also >= 3 questions). Less history than that = "Complete more quizzes to see improvement trends."

## Dates and timezone

All dates are the student's **local calendar days**. The database converts every timestamp with
`AT TIME ZONE <profile timezone>` and also decides "today" there; it hands the timezone and today back, so the rest of
the code uses exactly the same ones. An unknown timezone falls back to UTC. Ranges: 7 / 30 / 90 days (ending today,
including today) or all time; the previous period of equal length gives the comparison (not for all time, and only if
it had study time). Bars are per day for 7 and 30 days, per week (Monday start) for 90 days and all time.

## API

`GET /api/progress/summary?range=7d|30d|90d|all` (default `30d`) - one aggregated, read-only response
(`progressResponseSchema`): `studyTime`, `streak`, `quiz`, `subjects`, `topics`, `topicSummary`, `weakAreas`,
`improving`, `activity`. Requires a valid token; the student comes only from the token (there is no user id in the
request); an unknown range is a 400. 60 requests/minute. The dashboard calls the same service for its snapshot
(`progress` field), and a failure there never breaks the dashboard.

## Performance

- One request per page view and per range change. No polling, timers or background work.
- One SQL statement (CTEs + JSON) reads everything, inside the existing `withUser` transaction (RLS as the student).
  Measured against the real database: ~1.3 s median for the full page, ~1.1 s for the dashboard snapshot, of which
  ~0.9 s is the fixed per-request cost every endpoint pays (7 round trips for the RLS wrapper). The first version
  used 8 parameterised statements and took ~2.4 s: parameterised queries are not pipelined, so each one cost a round trip.
- Server-side execution of the parts is under 1 ms each (EXPLAIN ANALYZE), so no index was added; the existing
  `study_sessions (user_id, scheduled_date)` and `quiz_attempts (user_id, started_at)` indexes already lead with `user_id`.

## Tests

- `apps/api/src/progress/compute.test.ts` - definitions, streaks, ranges, study time, quiz stats, topic analysis.
- `apps/api/src/routes/progress.test.ts` - auth, ownership, validation, ranges, timezone, empty states, dashboard.
- `apps/api/src/progress/progress.integration.test.ts` - live DB (rolled back): the real SQL, timezone conversion,
  ownership, unfinished attempts, unanswered questions.
- `apps/web/src/features/progress/progress.test.tsx` - the page, range filter, empty/loading/error states, links.
- Dev preview: `/dev/progress` (`?empty=1` for a new student); development builds only.
