# Flashcards and mind maps

Two study tools that turn a student's own notes (or a subject they type) into something they can revise from.

| | Flashcards (`/flashcards`) | Mind maps (`/mindmaps`) |
|---|---|---|
| Made from | Up to 3 of the student's ready notes (optional focus), or a subject/topic | The same |
| Size | 5-30 cards (default 12) | small / medium / large (about 14 / 28 / 48 ideas) |
| After it is made | Review with spaced repetition; add, edit, delete cards by hand | Fold and unfold branches, zoom, read as an outline, download as SVG, draw again |
| By hand | Yes - an empty deck the student fills in (no AI, no daily quota) | No |

## How it works

* **One AI call per request.** `study-tools/generate.ts` is the sixth (and last) approved AI call site (see `policy.guard.test.ts`). It makes ONE call when the student presses the button - no retries, no polling, nothing scheduled. An unusable answer shows "The AI's answer couldn't be read. Please try again." and the student decides whether to press again.
* **Asynchronous, like quizzes.** `POST .../generate` answers `202` at once with status `generating`; the page polls (every 3 s, only while visible) until `ready` or `error`. A job lost to a restart is marked failed after 12 minutes instead of spinning forever. A job is cut off at 10 minutes.
* **Free-quota protection.** Every AI action is charged against the student's daily AI allowance (see `docs/AI_LIMITS.md`; a deck or a map costs 2 uses, administrators are never limited), at most 2 jobs run per student at a time, and the AI endpoints are also rate-limited to 6 per minute per client. Manual decks and cards cost nothing.
* **The model's output is untrusted.** `study-tools/parse.ts` cleans it: control characters and markdown stripped, lengths capped, duplicate cards and sibling labels dropped, map depth (4), children per node (8) and total size (60) enforced, node ids assigned by the server. The notes are fenced in the prompt as data, never instructions.
* **Spaced repetition** (`study-tools/srs.ts`, a small SM-2 variant). The browser only sends `again | hard | good | easy`; the server decides when the card comes back, so a tampered client cannot schedule or skip anything. Again = 10 minutes; Good = 1 day, then 3, then interval x ease; Easy jumps further and raises ease; Hard grows slowly and lowers ease. Each answer button shows when it would bring the card back.
* **No provider fallback.** A Gemini quota/provider error fails the request; no local or demo content replaces it. AI startup is currently blocked while the candidate model's free-tier eligibility is unverified.

## Data and privacy

Tables `flashcard_decks`, `flashcards`, `mindmaps` (migration `0018_study_tools.sql`, additive). They are **server-only**: RLS is on and no client role has any grant or policy, so the browser can reach them only through the API, which scopes every query by the verified user id. Someone else's deck, card or map is indistinguishable from a missing one (404). Deleting a deck deletes its cards; deleting a user deletes everything.

When AI is enabled, prompts and relevant note passages used to generate a deck or map may be sent to Google Gemini. Google's unpaid-tier terms say submitted content may be used to improve products and may be reviewed by humans. Account isolation does not mean AI content stays within this application; see `AI_POLICY.md`.

## API (all need a signed-in, active account)

| Method and path | What it does |
|---|---|
| `GET /api/flashcards/decks` | Decks with card / due / new counts, plus cards due and reviewed today |
| `POST /api/flashcards/decks/generate` | Start writing a deck with the AI (202) |
| `POST /api/flashcards/decks` | Create an empty deck |
| `GET / PATCH / DELETE /api/flashcards/decks/:id` | Read (with cards) / rename / delete |
| `POST /api/flashcards/decks/:id/cards` | Add a card |
| `GET /api/flashcards/decks/:id/study` | The next study round (due cards first, then new; at most 20) |
| `PATCH / DELETE /api/flashcards/cards/:id` | Edit / delete a card |
| `POST /api/flashcards/cards/:id/review` | `{ grade }` - the server reschedules the card |
| `POST /api/mindmaps/generate` | Start drawing a map with the AI (202) |
| `GET /api/mindmaps` | The student's maps (without trees) |
| `GET / PATCH / DELETE /api/mindmaps/:id` | Read (with tree) / rename / delete |
| `POST /api/mindmaps/:id/regenerate` | A new map from the same source; the old one is kept |

## Tests

`study-tools/srs.test.ts`, `parse.test.ts`, `service.test.ts` (generation, limits, isolation, scheduling), `routes/study-tools.test.ts` (auth, validation, 404 isolation, rate limit), `study-tools.integration.test.ts` (real database, rolled back: persistence, isolation, no client access, cascade), and on the web side `pages/study-tools.test.tsx` and `features/study-tools/mindmapLayout.test.ts`.
