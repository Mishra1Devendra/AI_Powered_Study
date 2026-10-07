# Dashboard data roadmap (proposal - nothing here has been applied)

## Where things stand after Phase 2

The dashboard UI and its API contract (`GET /api/dashboard`, schema in `packages/shared/src/dashboard.ts`) are complete.
Only `student_profiles` exists in the database, so the **profile is the only real data**. Every other section returns
`null` / `[]` and the UI shows an honest empty state. No fake rows exist in the database.

**No Phase 2 migration is proposed.** Tables created now would sit empty until the features that write to them exist,
so the dashboard would look identical. Each table should arrive in the phase that populates it (additive migration,
RLS on from day one, read through `withUser()`), and the matching section then lights up with no UI change.

## Which phase lights up which section

| Dashboard section | Source table(s) (proposed) | Added in | Notes |
|---|---|---|---|
| Recent activity: tutor | `conversations`, `messages` | Phase 3 (AI Tutor) | |
| Recent activity: notes | `documents` | Phase 4 (Notes) - done | Storage bucket + RLS added; see NOTES.md |
| Quiz average, recent quizzes | `quizzes`, `quiz_questions`, `quiz_attempts`, `quiz_answers` | Phase 5 - done | Average of the latest 10 finished attempts; one activity row per finished attempt; see QUIZ.md |
| Subject progress, continue learning | `subjects`, `topics`, `topic_progress` | Later (with Progress) | Phase 5 stores a quiz question's topic as plain text instead; a `topics` table can be backfilled from it |
| Weak topics | `weak_topics` (derived from quiz answers) | Phase 6 | Requires a minimum-attempts threshold so nothing is flagged on thin data |
| Today's plan, planned time, tasks | `study_plans`, `study_plan_items` | Phase 7 | |
| Study time, streak, recent sessions | `study_sessions` | Phase 3 (start recording) | Streak is derived from distinct study days in the student's timezone |

## Design rules for those migrations

- Every table has `user_id uuid not null references auth.users(id) on delete cascade`, RLS enabled, and own-row
  policies using `(select auth.uid()) = user_id`. Revoke `anon`; grant only what clients need.
- Index `(user_id, created_at desc)` on activity-style tables and `(user_id, <fk>)` on foreign keys.
- No destructive changes; each migration is reviewed with you before it is applied.
- The dashboard loader for a section is added next to `buildDashboard()` in `apps/api/src/dashboard/` and is covered
  by an integration test against the live database in a rolled-back transaction (same pattern as the RLS tests).

## Open decision for later

"Today" depends on the student's timezone. `student_profiles.timezone` defaults to `UTC`. Before streaks or "today's
plan" go live, set it from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) on first sign-in, with
an override in Settings.
