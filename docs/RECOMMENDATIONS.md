# Smart Revision & Recommendations (Phase 10)

Routes: `/recommendations` (full page), a "Recommended for You" card on the Dashboard (top 3, "View All →").
Question answered: **what should I study next, why, and what is the best way to revise it?**

## Architecture

```
Database (existing tables only)
  -> facts, calculated by the app / database (accuracy, repeated misses, recency, vivas, plan, tutor, notes)
  -> deterministic engine (recommendations/engine.ts)  -> ranked recommendations with reasons and actions
  -> [optional, on a button press] ONE Gemini request that rewrites those facts in friendlier words (when enabled)
  -> frontend
```

- **No AI is used to decide or calculate anything.** `GET /api/recommendations` is deterministic and never calls a model; the
  same data always gives the same answer. If AI is down, nothing changes on the page.
- The optional "Explain my priorities" button calls `POST /api/recommendations/explain`: the server recomputes the top 5
  recommendations itself (it takes no input), sends them to the model as plain lines with their already-written reasons, and
  makes **one** call - no retry, never on page load, never scheduled. The answer is checked before it is shown: unknown ids are
  dropped, texts are cleaned and length-limited, and **any number that is not in the supplied facts is dropped** (an invented
  score, count or date). Reading is tolerant: a reply with a repeated `items` key or broken JSON still yields its complete,
  valid items. Any failure is a normal `available: false` answer with a calm message, never an error page. When enabled, those
  recommendation facts may be sent to Google Gemini; see `AI_POLICY.md`.
- Gemini errors do not fall back to a local model, mock, or another provider. AI startup is currently blocked while the candidate
  model's free-tier eligibility is unverified.

## Where the facts come from (no new tables, no migrations)

| Fact | Source |
| --- | --- |
| Topic accuracy, level, improvement | quiz attempts/answers/questions (same code as Progress: `topicAnalysis`) |
| Repeated mistakes | a question wrong or unanswered in 2+ finished attempts (`quiz_answers`) |
| Viva weakness | completed `viva_sessions` with a topic |
| Not practiced recently | newest of: quiz attempt, viva, completed study session, tutor conversation on that topic |
| Upcoming / missed sessions | `study_sessions` of the **active** plan |
| Notes to review | a note a quiz was generated from (`quiz_sources`), for that topic's questions - only real links |
| Exam date, minutes/day | the active `study_plans` row (only used in the optional AI wording) |

Two reads run in parallel on separate connections: the Progress load (all time) and one extra statement for repeated misses,
note links, tutor recency and the plan. All dates are the student's local days (profile timezone).

## Ranking (documented in `packages/shared/src/recommendations.ts`)

Points add up (cap 100); **high** >= 60, **medium** >= 35, otherwise **low**; a weak topic with 80+ is "urgent".

| Signal | Points |
| --- | --- |
| Weak (< 50%, 5+ questions) | +60, up to +10 more the lower the accuracy |
| Needs practice (50-74%) | +22 |
| 1-4 questions only (too few to judge) | +12 (never called weak) |
| Each question missed in 2+ attempts | +20 (max +40) |
| Average viva on the topic < 50% / 50-74% | +35 / +12 |
| Needs work and not practiced for 7+ / 14+ days | +6 / +12 |
| Planned session on the topic within 3 / 7 days | +14 / +7 |
| Improving (recent >= previous + 10 points) | 20 |
| Strong (>= 75%) | 8 (+10 if not practiced for 14+ days) |

Types: URGENT_REVISION, WEAK_TOPIC, REPEATED_MISTAKE, PRACTICE_MORE, VIVA_PRACTICE, UPCOMING_STUDY, IMPROVING, MAINTAIN_STRENGTH.
Tutor and notes are **actions** on these, not separate recommendation types. One recommendation per topic (plus the nearest planned
session and the latest missed session of the active plan). The page's sections follow the type: Weak, Repeated mistakes, Needs
practice, Improving, Strong; "Recommended Now" is the top three non-strength items; empty sections are hidden.

## Actions (data, not links; nothing starts)

Each recommendation carries up to four actions. The server says what to open; the web app builds the link:

- Quiz: `/quiz/new?subject=&topic=&count=` - the existing form, pre-filled. Not generated until Create is pressed.
- Viva: `/viva?subject=&topic=` - the existing setup, pre-filled (only when the subject is known). Not started.
- Tutor: navigation state `{ draft, subject, topic }` - put into the composer, **not sent**.
- Notes: `/notes/:id` - only when a quiz for that topic was made from that note.
- Study plan: `/study-plan?session=:id` - opens the session. The plan is never changed silently.

## API

`GET /api/recommendations?limit=1-30` (default 10; anything else is 400) and `POST /api/recommendations/explain` (6/min). Both need a
valid token; the student comes only from the token. A recommendation never exposes database internals (ids are `TYPE:topic`).

## Known limitations

- Provider output is untrusted; that is why its text is checked and why the deterministic recommendations never depend on it.
- Topic matching is by name (case/space-insensitive). "Algebra" in a quiz and "Algebra basics" in a plan are different topics.
- Questions without a topic are left out; notes links need quizzes generated from notes with topics on their questions.
- Repeated mistakes need retakes (the same question seen in 2+ attempts).

## Tests

`apps/api/src/recommendations/engine.test.ts` (calculations and ranking), `apps/api/src/routes/recommendations.test.ts` (auth, ownership,
validation, empty data, timezone, no AI on listing, explanation checks, provider errors), `recommendations.integration.test.ts` (live DB,
rolled back), `apps/web/src/features/recommendations/recommendations.test.tsx`; dev preview `/dev/recommendations`
(`?empty=1`, `?plan=1`).

## Phase 11: notes action

`GET /api/recommendations` adds a "Review notes" action when one of the student's ready documents has a passage containing all of the topic's words
(single database statement, ownership-checked). Otherwise actions are unchanged. See `docs/KNOWLEDGE.md`.
