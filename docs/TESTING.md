# Testing & release verification (Phase 13)

## Layers

| Layer | Command (repo root) | Needs |
|---|---|---|
| Typecheck | `npm run typecheck` | nothing |
| API unit/route tests (in-memory repos, scripted AI) | `npm test -w @copilot/api` | nothing |
| Web tests (jsdom) | `npm test -w @copilot/web` | nothing. **Run them while nothing heavy is running**: under CPU load a few async UI tests exceed vitest's 5 s timeout. |
| Live-database tests | `npm run test:integration -w @copilot/api` (add `-- --testTimeout=900000`) | `.env` with `DATABASE_URL`, `SUPABASE_URL`; about 8-10 minutes |
| Real-stack journey (`src/e2e/journey.integration.test.ts`) | included above | as above |
| Live AI integration tests | intentionally absent | Do not contact an AI provider to test model eligibility or quota behavior |
| Production bundle guard | `npm run build -w @copilot/web && npm run verify:bundle -w @copilot/web` | nothing |
| AI cost report | `npm run check:ai` | nothing; sends no AI request |

## How the live tests stay safe

* Every live test runs inside **one database transaction that is always rolled back** (`throw ROLLBACK`). Synthetic users (`*@invalid.test`) are inserted into `auth.users` inside that transaction and vanish with it. No real student data is read or written, nothing is deleted, no RLS is disabled.
* Test users are authenticated with JWTs signed by a **locally generated key pair**, verified by the real `createTokenVerifier` against a local JWKS. The tests never create accounts in Supabase Auth and never type a password anywhere.
* Supabase Storage's HTTP API is replaced by an in-memory map; the storage **policies** are tested directly against `storage.objects` with the student/anon roles.
* Focused Gemini tests use mocked HTTP responses only. They make no external request. The active runtime is currently blocked pending model free-tier verification.

## What the journey test proves (one student, then a second one trying to get in)

Profile created by the signup trigger -> real text-PDF upload and processing -> grounded Tutor answer with real sources -> quiz from the note (answers hidden while taking it) -> attempt and review -> study plan -> viva (key points hidden until evaluated) -> progress derived from the real attempts -> recommendations -> search and notifications. Then student B: every one of A's records is invisible or refused over the API (guessed UUIDs, swapped ids in URL/body, search) **and** at the database level for every student-data table (select/insert/update/delete as B and as anon), plus storage-bucket rules, the 401 matrix, per-IP rate limiting and the answer-key column privileges.

## What is NOT covered (be honest about it)

* **No real-browser, real-account run.** Creating Supabase Auth accounts and typing passwords was deliberately not done by the assistant. The browser checks were limited to the unauthenticated surface (login/signup render, protected-route redirect to `/login`, 404 page, manifest/icons, no service worker, no horizontal overflow at 375 px). A person should do one manual pass: sign up, upload a PDF, ask the Tutor, take a quiz.
* Supabase Storage over its real HTTP API, and Supabase Auth's own flows (email confirmation, reset), are not exercised.
* No load test; no multi-user concurrency test against a shared AI provider.
* Scanned (image-only) PDFs are detected and reported with a calm message; there is no OCR.
