# Daily AI limits

Every account **except administrators** has a daily allowance of AI "uses"; administrators have none (and are never counted). Google Gemini is the only intended provider, but its candidate model's free-tier eligibility is currently unverified and the API is disabled. These application limits do not establish provider quota or pricing terms; see `AI_POLICY.md`.

## What costs what

| Action | Uses |
|---|---|
| AI Tutor reply (also "regenerate") | 1 |
| Notes assistant answer (also "regenerate") | 1 |
| Viva: starting it, each evaluated answer, each next question | 1 each |
| Recommendations: "Explain my priorities" | 1 |
| Study check (the 5 questions before completing a session) | 1 |
| Study plan (also "regenerate") | 2 |
| Flashcard deck written by the AI | 2 |
| Mind map (also "draw again") | 2 |
| Quiz (also "regenerate") | 3 |

Everything else costs **nothing**: reading, studying flashcards, taking and reviewing quizzes, search, progress, uploads, writing cards by hand. The costs live in one place, `AI_COST` in `packages/shared/src/ai-usage.ts`.

The default allowance is **100 uses per UTC day** (about 100 chat replies, or 30 quizzes). Change it with `AI_DAILY_UNITS` in `.env`.

## How it works

* `app.aiQuota.guard("<feature>")` is a route hook placed after `authenticate` on every route that asks the AI for something. It charges the feature's cost **before** the AI is asked, in one atomic SQL statement (`insert … on conflict do update … where units + cost <= limit`), so two requests at once cannot both squeeze under the limit.
* The role comes from the database lookup `authenticate` already does on every request, never from the client. `admin` skips the charge entirely.
* A request that then ends with an error status (bad input, not found, conflict) is **refunded** automatically, so a student only pays for work that started. The study check also refunds when it returns an existing set instead of asking the AI again.
* When the allowance is spent the API answers **429** with `error: "ai_limit_reached"`, a plain message ("…you have 1 left of 100. It starts again in about 3 hours. Everything that doesn't use AI still works.") and `limit`, `used`, `remaining`, `resetsAt`.
* `GET /api/me/ai-usage` returns the same numbers (read-only, free). The web app shows them live: a pill at the top right of the screens that use AI (tutor, notes workspace, quiz, study plan, viva, flashcards, mind maps, recommendations, settings), a card in Settings, and a note beside the buttons that use AI. They refresh the moment an AI action happens (including streamed replies), when you return to the tab, and once a minute while the tab is visible; all three read one shared store (`features/ai-usage/store.ts`). On a phone the pill shows just the number, and the theme and bug-report buttons move into the account menu to make room.
* Administrators are also exempt from the other per-action caps (for example the 6 study checks per session per day). The per-minute rate limits (abuse protection, not usage) apply to everyone.
* The counters live in `ai_usage` (migration `0019_ai_usage.sql`): one row per account per UTC day, server-only (RLS on, no client grants), so a student cannot read or change their own counter.

## Tests

`ai-quota/quota.test.ts` (rules, refunds, midnight reset, concurrency), `routes/ai-quota.test.ts` (student 429, admin unlimited, isolation, refund on error, usage endpoint), `planner/checks/checks-quota.test.ts`, `ai-quota/guarded-routes.test.ts` (fails if an AI route loses its guard), `ai-quota.integration.test.ts` (real database, rolled back), and `features/ai-usage/AiUsageNote.test.tsx` on the web side.
