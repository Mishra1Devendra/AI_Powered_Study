# AI Quiz (Phase 5)

Students create a quiz from their own notes or from a subject/topic, take it, and get a score computed
by the server, explanations, topic-by-topic accuracy and a mistake review. The active API is configured for Google Gemini only;
the current candidate model's free-tier eligibility is unverified, so API startup is blocked. When enabled, quiz prompts and
relevant note passages may be sent to Google. There is no local-model or alternate-provider fallback; see `AI_POLICY.md`.

## Flow

```
Create (UI) ──▶ POST /api/quiz/generate ──▶ 202 { status: "generating" }  ──▶ UI polls GET /api/quiz/:id
                    │
                    └─ background job (one per student, 40 min hard deadline):
                         pick passages from the notes (Phase 4 chunks, full-text search) ─▶ prompt ─▶ Gemini (JSON mode, when enabled)
                         ─▶ validate EVERY question ─▶ top up if some were rejected ─▶ store all, or store nothing
Take  ──▶ POST /:id/start ─▶ PUT /attempts/:id/answers (autosave) ─▶ POST /attempts/:id/submit ─▶ result
```

| Piece | Where |
|---|---|
| Routes (`/api/quiz/*`) | `apps/api/src/routes/quiz.ts` |
| Service (ownership, attempts, timer, grading) | `apps/api/src/quiz/service.ts` |
| Generation loop (batches, top-up, dedupe, shuffle) | `apps/api/src/quiz/generate.ts` |
| AI-output validation | `apps/api/src/quiz/validate.ts` |
| Scoring + topic accuracy | `apps/api/src/quiz/grading.ts` |
| Persistence | `apps/api/src/quiz/repository.ts` |
| Prompt | `apps/api/src/services/ai/quiz/prompt.ts` |
| Shared contracts | `packages/shared/src/quiz.ts` |
| UI | `apps/web/src/pages/Quiz*.tsx`, `apps/web/src/features/quiz/*` |

## Endpoints (all need a Supabase JWT; someone else's id is always 404)

| | |
|---|---|
| `GET /api/quiz/options` | Only what this student has: ready notes, topics from their tutor chats |
| `POST /api/quiz/generate` | `{ source, difficulty, count, questionTypes, timeLimitMinutes }` -> 202; 409 if one is already being made |
| `GET /api/quiz` | Quizzes + real performance summary |
| `GET /api/quiz/attempts` | Attempt history (newest first) |
| `GET /api/quiz/:id` | Quiz + questions **without answers** + its attempts |
| `POST /api/quiz/:id/start` / `/retry` | Start, resume the open attempt, or new attempt in a new order |
| `POST /api/quiz/:id/regenerate` | A new quiz, same settings/sources, told to avoid the old questions |
| `GET /api/quiz/attempts/:id` | The attempt as the player needs it (+ server clock, deadline) |
| `PUT /api/quiz/attempts/:id/answers` | Autosave choices (`selected: null` clears one) |
| `POST /api/quiz/attempts/:id/submit` | Grade on the server; submitting twice returns the same result |
| `GET /api/quiz/attempts/:id/result` | Result with answer key + explanations; 409 until submitted |

## Answer security

* The browser never receives `correctAnswer`, `explanation` or the source reference until the attempt is
  submitted: the player types (`PlayQuestion`) simply do not have those fields.
* Defence in depth in Postgres: the students' role has **no SELECT on `quiz_questions.correct_answer`,
  `explanation`, `source_ref`** (column-level grants), no INSERT/UPDATE/DELETE on any quiz table, and RLS
  limits every read to the owner. A direct PostgREST call with a valid student token still cannot read
  an answer. The API reads the key with its privileged connection only after verifying ownership, and
  only returns it for a submitted/expired attempt.
* Scores are always calculated by the server from the stored key; the browser only sends choices. Extra
  fields (a claimed score, `isCorrect`) are ignored. Duplicate/simultaneous submits grade once.
* MCQ options are shuffled on the server when stored, so answer position leaks nothing.

## Timer

Optional. The deadline (`expires_at`) is set by the server when the attempt starts. After the deadline
(+15 s network grace) saving is refused (410), the attempt is closed as `expired` using only answers
saved before the deadline, and the time taken is capped at the allowance. The countdown in the UI is just
a display of the server's deadline (it uses the server clock offset).

## Quality gate (Phase 6): structure + basic quality, NOT fact-checking

```
Generate -> parse JSON -> structural checks -> duplicate checks -> basic quality checks -> PASS: save / FAIL: reject
```

**Structural** (`quiz/validate.ts`): supported type and the right number per type; question text 12-500 chars;
MCQ phrased as a question or a blank, exactly 4 distinct non-empty options, no "all/none of the above", exactly
one valid correct answer (index, letter or exact option text); True/False has a real boolean; explanation present;
valid difficulty; topics only from the notes' real section titles (or the student's own topic); `source` only if
that passage was really supplied; trailing JSON field names leaked into the options are stripped.

**Duplicates**: exact, normalised and lightly reworded questions (word-overlap >= 0.7) are rejected within the quiz,
against the previous quiz's questions on a regeneration, and across top-up calls. No embeddings, no vector search.

**Quality** (`quiz/quality.ts`, deterministic text checks):

| Check | Rejects |
|---|---|
| Wording | MCQ shorter than 5 words; True/False shorter than 6 words or phrased as a question |
| Options | near-identical options ("Mitochondria" / "The mitochondria"); an option that repeats the question; "both A and B" / "all of these"; an option longer than 25 words; the right answer 3x longer than all others (giveaway); (notes quizzes) 2+ options that are whole sentences copied from the notes |
| Explanation | under 15 or over 500 characters; identical to the question; shares no meaningful word with the question, the right answer or the quote |
| Grounding (notes quizzes, real model only) | no supporting quote; a quote that is **not actually in the notes**; a question or right answer not covered by that quote; a True statement the quote does not support; a False statement that is a verbatim copy of the notes |

For a notes quiz the model must return an `evidence` sentence copied from the notes. Code verifies it really occurs
in the supplied passages (case/punctuation tolerant), so invented content is much harder to slip through. The
verified quote is stored in `quiz_questions.source_ref` (existing JSON column; no schema change), is never sent to the
browser during a quiz, and is shown on the result next to the page and section.

Subject/topic quizzes have no notes to check against, so they get the structural, duplicate, wording, option and
explanation checks but not the grounding checks. Tests use scripted responses; the active runtime has no mock fallback.

**Bounded effort**: one model call per 5 questions plus at most 2 replacement calls; generation stops early after 2 calls
in a row that produce nothing usable. If fewer acceptable questions than requested exist, the quiz is **not saved**, and
the error says what went wrong (for example "questions not backed by your notes (6)").

### What this does not do
Validation cannot know that a statement is true. The grounding checks make *invented* content less likely and catch
many badly-formed questions, but a small model can still write a question that is on-topic, supported by a real quote,
passes every check, and is still pointless, awkward or subtly wrong. The result page says so, and every mistake has
"Ask AI to explain".

## Progress while a quiz is made

The job reports real stages - Preparing quiz / Generating questions / Checking questions / Finalizing quiz - with the
real count of questions that have passed the checks. It is kept in server memory while the job runs and returned with
the quiz (`quiz.progress`); there are no percentages and no estimates. Polling is one cheap query (no questions or
attempts loaded, no database writes), is skipped while the browser tab is hidden, and the home list polls every 6 s.

## Student experience

* Answering: A-D / 1-4 choose, N / P move between questions; the chosen option shows a check mark as well as a border;
  "Review unanswered" in the submit dialog jumps to the first blank question; the timer turns amber in the last 5 minutes
  and red in the last minute.
* Result: score ring, counts, topic accuracy, and for every question *what you answered / the correct answer / why /
  the concept / the sentence from your notes* (notes quizzes). A note says AI questions can be wrong.
* Ask AI to explain opens the existing Tutor with the question, correct answer, explanation, topic and the notes quote
  ready to send (nothing is sent automatically).

## Data model (migrations 0007, 0008; additive)

`quizzes` (config, status, provider/model/`is_mock`), `quiz_sources` (note ids only - no text copied),
`quiz_questions` (options/answer/explanation/topic/difficulty/source ref), `quiz_attempts` (one open per
quiz; question order per attempt; score/percentage/time), `quiz_answers` (one per question per attempt,
`is_correct` set at grading). Composite `(id, user_id)` foreign keys make cross-student or cross-quiz
links impossible. Topics are stored as text on the question (there is no `subjects`/`topics` table yet).

## Running locally

The API currently refuses to start until the candidate Gemini model's free-tier eligibility is verified. If Gemini is later enabled,
quota or provider errors fail clearly and are not replaced with local or demo output.

Preview without any backend: `/dev/quiz` (fixtures only; stripped from production builds, checked by
`npm run verify:bundle -w @copilot/web`).

## Known limits

* Quality still depends on the model. `llama3.2:3b` gives reliable structure and, with the quality gate, far fewer
  invented or malformed questions, but it can still write weak distractors, questions that are only loosely tied to the
  quote, easy/hard labels that do not match, and occasionally a wrong answer key. Treat quizzes as practice, not as truth.
* Strictness has a cost: with a small model some generations fail the gate and must be retried; asking for fewer
  questions works better.
* A 5-question quiz takes roughly 1.5-5 minutes on a CPU with little free RAM; 20 questions can take 10+ minutes.
* Short-answer and numerical questions are in the schema but not generated or gradable yet.
* Generation runs in the API process; if the server restarts mid-way the quiz is marked failed.
* One quiz can be generated at a time per student.
