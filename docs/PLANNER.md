# AI Study Planner (Phase 7)

Route: `/study-plan` (active plan + previous plans), `/study-plan/new` (form, `?from=<planId>` copies settings), `/study-plan/:planId` (any of your plans). Dashboard "Today's Study Plan" links to `/study-plan?session=<id>`.

## How a plan is made

```
POST /api/study-plans/generate  ->  202 { plan: { status: "generating" } }
  preparing   checks the dates and study days (no AI if hopeless)
  analyzing   ONE Google Gemini request (JSON mode) when the AI service is enabled: topic names, order, first-session minutes per subject
  scheduling  deterministic scheduler assigns dates/times (planner/schedule.ts)
  checking    independent validator re-checks every session (validateSchedule)
  saving      one transaction: insert sessions, archive previous active plan, activate this one
```

- The AI never writes dates. It only names topics; the app schedules them, so every session is always before the exam, on a chosen weekday, and within the daily minutes (max 4 sessions/day, 15-120 min each).
- Exactly one model call per plan. No retries, no per-day calls, no background or scheduled AI, no polling that calls AI (the UI polls `GET /api/study-plans/:id` only while a plan is generating; that is a DB read).
- One generation per student at a time (409 `generation_in_progress`). The form and Regenerate button also guard against double clicks.
- The model's answer is untrusted: unknown subjects are ignored, names are cleaned and length-limited, "Day 3:"/date prefixes are stripped, minutes are clamped, at most 8 AI topics per subject (the student's own topics always come first, up to 12). A reply cut off at the token limit keeps its complete topics (`salvagePlanJson`); an unreadable reply fails the plan with a safe message and saves nothing.
- Gemini provider errors stop the request; there is no local-model, mock, or alternate-provider fallback. AI startup is currently
  blocked because the candidate Gemini model's free-tier eligibility is unverified. When enabled, prompts containing study-plan data
  may be sent to Google; see `AI_POLICY.md`.
- Weak topics: real quiz accuracy per topic (the shared "Weak" definition: under 50% over at least 5 questions) is passed to the prompt and gets an extra revision session.
- If time is short, lower-priority topics are listed as "Not scheduled" instead of being silently dropped.

## Sessions

Statuses: `planned`, `in_progress`, `completed`, `skipped`, `missed`, `rescheduled`. Activity types: learn, practice, quiz, revision, mock_test ("Practice test").

| Action | From | Result |
| --- | --- | --- |
| start | planned | in_progress (`started_at`) |
| complete | planned, in_progress | completed (`completed_at`) |
| skip | planned, in_progress | skipped |
| miss ("Keep as missed") | planned/in_progress on a past day | missed |
| reschedule | planned, in_progress, skipped, missed | original -> `rescheduled` (kept), new planned session with `rescheduled_from_id` |

- "Missed" is derived for display (planned/in_progress with a past date); nothing is written until the student chooses Reschedule or Keep as missed.
- Reschedule targets today..exam-1, must fit the daily minutes and 4-sessions cap; with no date it picks the next study day with room, then any day, else 409.
- Only the active plan's sessions can change. Updates are conditional on the current status, so double clicks cannot double-apply.

## Plans

- Regenerate = a NEW plan with the same settings. The current plan stays active until the new one is ready, then it is archived with all its sessions and progress. Nothing is deleted. A failed regeneration leaves the current plan active.
- Previous (archived) plans are read-only and can be made active again.
- Edit: name, exam date (after today, within 180 days; cannot move before planned sessions), minutes per day (applies to future rescheduling).

## API

All routes require a valid token; the user id comes only from the token. Another student's id behaves as 404. Ids, dates, numbers and enums are validated with zod (`packages/shared/src/planner.ts`).

```
GET    /api/study-plans/options
POST   /api/study-plans/generate          (4/min)
GET    /api/study-plans
GET    /api/study-plans/:id
PATCH  /api/study-plans/:id
POST   /api/study-plans/:id/regenerate    (4/min)
POST   /api/study-plans/:id/activate
POST   /api/study-sessions/:id/:action    start|complete|skip|miss|reschedule
```

## Database (migrations 0009, 0010 - additive only)

- `study_plans`, `study_sessions`; RLS on, `*_select_own` policies; students have SELECT only, all writes go through the API.
- Composite FKs `(plan_id, user_id)` and `(rescheduled_from_id, user_id)` make cross-student links impossible.
- CHECK constraints mirror the API limits; partial unique index allows one active plan per student.

## Tests

- `apps/api/src/planner/*.test.ts` - scheduler, validator, topic validation, salvage, generation (scripted AI, provider errors, malformed JSON, deadline).
- `apps/api/src/routes/planner.test.ts` - auth, ownership, validation, duplicate generation, session actions, reschedule, regenerate, dashboard.
- `apps/api/src/planner/planner.integration.test.ts` - live DB, rolled back: RLS, grants, FKs, constraints, end-to-end.
- `apps/web/src/features/planner/planner.test.tsx` - UI flows against `dev/fakePlannerBackend.ts`.
- Dev preview: `/dev/study-plan` (development builds only).

## Study check (5 questions before "Mark complete")

A study session can no longer be completed with one click. **Mark complete** opens a short check:

1. The student's click starts it: the AI writes **5 multiple-choice questions** about the session's subject and topic (the same generator and quality gate as quizzes, one question type, medium difficulty). When enabled, the prompt may be sent to Google Gemini. While it writes, the screen polls with plain reads every 3 s (no AI work from polling).
2. The student answers all 5 and submits. **The server grades** from the stored answer key (the key never reaches the browser before submission; the table is server-only, RLS on, no client grants).
3. **3 of 5 or more passes**: the session is completed in the same request. **Fewer fails**: the session stays open, the correct answers and explanations are shown, and the student may request a **new set** (questions already asked by the real AI are avoided).
4. The old direct `complete` action now returns `409 check_required` unless a passed check exists, so there is no way around the check through the API.

Limits and safety: one open set per session (a double click or reload shares it, so one AI call), at most 6 sets per session per 24 hours (`429 too_many_checks`), one submission per set, answers must cover exactly the 5 questions, and another student's id behaves like a missing one. No automatic provider fallback and no background AI: every new set is a click. Provider errors fail safely; no demo questions replace a failed AI response.

Not done: questions are about the topic in general (not from the student's own notes), and the check is not applied to "skip" or "reschedule".
