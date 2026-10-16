# AI Viva (Phase 9, text only)

Routes: `/viva` (setup + history), `/viva/:id` (the live viva, or its results/review). Dashboard shows an "AI Viva" card;
Progress has a separate "Viva performance" section. **Text only** - no microphone, speech, voice, video or webcam.

## How a viva runs

```
Start Viva      POST /api/viva/sessions            1 model call: the examiner's first question  -> 201 { session, questions, result }
Submit answer   POST /api/viva/sessions/:id/answer 1 model call: evaluates THAT answer
Next question   POST /api/viva/sessions/:id/next   1 model call: the next question (a follow-up when warranted)
...the last answer completes the viva (no extra call): the score is calculated, not asked of the model
End early       POST /api/viva/sessions/:id/abandon  no model call
```

- Every call is a direct reaction to a student action: no background AI, no polling, no scheduled work. When enabled, prompts that
  include the student's subject, topic, or answer may be sent to Google Gemini; the UI shows the real step
  ("Preparing your Viva…", "Evaluating your answer…", "Preparing the next question…") and never a made-up percentage.
- One model step at a time per student: a second click or a second tab gets `409 examiner_busy`; the UI also guards
  double clicks. Asking for "next" when the next question already exists returns it without any model call.
- Each question comes with a short **concept** label and 2-4 secret **key points** (what a strong answer covers). The key
  points are only a guide for the evaluator, never a keyword checklist (the prompt says to judge meaning), and are only
  sent to the browser once the question has been answered. In the database `viva_questions.key_points` is not readable by
  the students' role at all (column-level grant).
- **Follow-ups**: if the evaluation flags `shouldFollowUp` and the answer scored below 75, the next question is a follow-up
  probing the gap. Never two follow-ups in a row, never after a strong answer.
- **Difficulty**: easy / medium / hard (no adaptive mode: unreliable with a 3B model). **Questions**: 5 (default, recommended),
  10, 15 in the form (the API accepts 3-15).

## Model output is validated, never trusted

`viva/validate.ts`: a question needs a real question (>= 15 chars), a concept and key points, and must not repeat an earlier
question (word-overlap >= 75%). An evaluation needs four whole-number scores 0-10 (a 0-100 scale or a missing score is
rejected), feedback text, and cleaned missing concepts. Student text (subject, topic, answers) goes into the prompt as quoted
data and the examiner is told to ignore instructions inside it.

**Retries are bounded**: an unreadable or invalid reply is retried ONCE (so a step makes at most 2 model calls). Provider
errors are never retried. A timeout shows "The examiner took too long to respond. Please try again." and saves nothing; the
student's text stays in the box (and in `sessionStorage` across a reload). A whole step is cut off after 10 minutes.

## Scoring (documented, advisory)

```
answer score (0-100) = 10 x (0.40 correctness + 0.30 completeness + 0.20 clarity + 0.10 confidence)
viva score  (0-100)  = mean of its answer scores           (calculated by the server, stored once at completion)
```

"Confidence" is the AI's rough estimate of how assured the written answer sounds - labelled as an estimate, smallest weight.
Levels use the same cut-offs as Progress: Strong >= 75%, Needs practice 50-74%, Weak < 50% (always written as words with the
number). Strong areas = concepts of answers >= 75; "needs improvement" = low-scoring concepts, the ideas the evaluations
named as missing (most often first) and the weakest dimension if it is below 60% - all derived from the actual answers.
The formula and the AI's scores are **not** scientifically validated, and the UI says so ("AI-generated evaluation ...
advisory").

## Provider policy

The active API has no local-model, mock, or alternate-provider fallback. Gemini quota or provider errors are returned safely.
The API currently refuses to start because the candidate model's free-tier eligibility is unverified. See `AI_POLICY.md` for
the external-processing and data-use notice.

## State machine

`in_progress -> completed` (the last answer) and `in_progress -> abandoned`. Nothing goes back; a completed or abandoned
viva rejects answers, "next" and abandon (409). "Practice again" creates a NEW viva with the same settings; old ones are kept.

## Database (migrations 0011, 0012 - additive only)

`viva_sessions`, `viva_questions`, `viva_answers`: RLS on with own-row read policies; students have SELECT only (writes via
the API); composite foreign keys tie every question and answer to its own student's viva; `unique(session, question_number)`
and `unique(question_id)` make a duplicate question or answer impossible; CHECK constraints mirror the API limits and keep a
completed viva consistent (score and time set together).

## Progress and dashboard

Progress adds `viva` (completed vivas in the period: count, average, best, latest, dimension averages, by subject, recent) in
the same single SQL statement as before. It is kept completely separate from the quiz numbers; abandoned/in-progress vivas never
count. The dashboard card shows the latest completed viva's score (any time) or invites a first one.

## Known limitations

- AI can misjudge answers; the evaluation is advisory and the key points it writes can be imperfect.
- Not grounded in notes (no RAG in this phase): the examiner only knows the subject/topic you typed.
- An evaluation that fails after the answer was typed is not stored (the text stays in the page to resubmit).

## Tests

`apps/api/src/viva/*.test.ts` (validation, scoring), `apps/api/src/routes/viva.test.ts` (auth, ownership, validation, flow,
duplicates, completion, abandon, AI errors/retry/timeout), `viva.integration.test.ts` (live DB, rolled back:
RLS, column secrecy, foreign keys, constraints, end to end), `apps/web/src/features/viva/viva.test.tsx`; dev preview `/dev/viva`.

## Phase 11: viva from your own material

`POST /api/viva/sessions` accepts optional `sourceType` (`general` default, `notes`, `document`) and `documentId`. Each question is based on one real passage
(stored as metadata in `viva_questions.source_ref`, shown as "Based on: ..."); the evaluation gets the same passage as an advisory reference. No relevant
material -> 422 `no_material`, no AI call. See `docs/KNOWLEDGE.md`.
