# AI Notes (Phase 4)

Students upload study material (PDF, TXT, Markdown) or paste text, then work with it in a
workspace: read it, jump around by outline, and use an AI study assistant that answers **only
from that document**, with citations.

## Architecture at a glance

```
Browser ──(JWT)──▶ Fastify API ──▶ Supabase Storage  (private bucket "notes", acting AS the student)
                        │      └──▶ Postgres (documents, document_chunks, conversations, messages; RLS)
                        └─────────▶ Google Gemini (when enabled; no fallback)
```

| Piece | Where |
|---|---|
| Routes (`/api/notes/*`) | `apps/api/src/routes/notes.ts` |
| Upload/process/list/delete logic | `apps/api/src/notes/service.ts` |
| Pipeline steps | `notes/file-validation.ts` → `extract.ts` → `normalize.ts` → `chunker.ts` |
| Storage client | `notes/storage.ts` |
| DB access (per-user `withUser()` + privileged writes) | `notes/repository.ts` |
| Retrieval | `notes/retrieval.ts` |
| Prompt | `services/ai/notes/prompt.ts` |
| Shared streaming engine (also used by the Tutor) | `tutor/turn.ts`, `routes/sse.ts` |
| Web UI | `apps/web/src/features/notes/*`, `pages/NotesPage.tsx`, `pages/NoteWorkspacePage.tsx` |
| Shared contracts/limits | `packages/shared/src/notes.ts` |

## Upload and processing flow

1. **Validate** (server decides, the browser only pre-checks): extension *and* content sniffing
   (`%PDF-` header; TXT/MD must be strict UTF-8), size ≤ 10 MB, filename sanitised, duplicate
   detection by content hash (HTTP 409 with the existing note's id).
2. **Create record** (`UPLOADING`) with a server-generated path `<userId>/<docId>/original.<ext>`.
   The client never chooses a storage path (a DB CHECK also enforces the owner prefix).
3. **Store** the original in the private bucket using the student's own JWT.
4. `PROCESSING`: **extract** (PDF via `unpdf`; text decode for TXT/MD) → **normalize** (hyphen
   joins, optional line unwrap) → **chunk** heading-aware (target ~1,100 chars, max 1,600,
   never mixes text across pages; records page, page end, deepest heading).
5. **Save** chunks and set `READY` in one transaction. Any failure sets `FAILED` with a stored,
   student-readable reason (password-protected, no selectable text, too many pages, ...). `POST
   /api/notes/:id/process` retries a failed note.

Progress is **real**: bytes sent are measured with `XMLHttpRequest`. Once all bytes are sent the
UI switches to an indeterminate "Processing" bar. No fake percentages, ever.

Limits (`NOTE_LIMITS`): 10 MB, 300 pages, 1,500 chunks, 200,000 pasted characters,
2,000-character questions. Scanned/image-only PDFs are rejected with a clear message (no OCR yet).

## Endpoints (all require a Supabase JWT)

| Method & path | Purpose |
|---|---|
| `POST /api/notes` | Multipart upload (field `file`) |
| `POST /api/notes/text` | Paste text `{ text, title? }` |
| `GET /api/notes?q&type&status&sort` | Library (search, filter, sort) |
| `GET /api/notes/:id` | Note + outline |
| `GET /api/notes/:id/content?cursor&limit` | Chunks, paged |
| `POST /api/notes/:id/process` | Retry processing |
| `DELETE /api/notes/:id` | **Soft** delete |
| `GET /api/notes/:id/conversation` | The note's assistant conversation |
| `POST /api/notes/:id/assistant` | Ask / run a study action (SSE stream) |
| `POST /api/notes/:id/assistant/regenerate` | Re-answer the last request (SSE) |

Study actions: explain, summarize, key_concepts, definitions, formulas, flashcards, quiz,
important_topics, ask (needs `question`).

## How answers stay grounded

* **Retrieval** (no vector DB): Postgres full-text search (`search_tsv`, GIN index, OR-queries)
  plus evenly spaced sections so whole-document actions (summarize, quiz) cover the document.
  At most 8 passages / ~9,000 characters per request.
* **Prompt**: fixed instructions → requested action → student/document context → the passages
  inside `<study_material>` (treated as **untrusted data**, never as instructions) → short history.
  Rules include: answer from the material; say when it is not covered; mark anything outside the
  notes as "Not in your notes, but generally: ..."; never invent pages, quotes or sources.
* **Citations are metadata, not model output.** The server builds `SourceRef`s (`S1`, chunk, page,
  heading) from the chunks it supplied. The UI makes `[S#]` clickable **only** if `S#` is in that
  message's sources; an invented `[S9]` stays plain text. Source chips show real page/heading.
* **Provenance**: AI answers identify the configured provider/model as returned by the API.
* Model output can skip citations or hedge awkwardly; citations and source chips are constructed from retrieved passages, never trusted from model text.

## Security model

* Ownership is enforced three ways: the API filters by the JWT's user, Postgres RLS (`documents`,
  `document_chunks`, `conversations`, `messages`) and composite FKs `(id, user_id)`, and Storage
  policies limited to the student's own folder (SELECT/INSERT only; no UPDATE/DELETE policies).
* Other users' notes return 404 (not 403), so existence is not revealed.
* No service-role key is used. The API forwards the student's JWT to Storage.
* Soft delete only: the row gets `deleted_at`; the file and chunks are retained. A hard purge
  needs the project owner's explicit approval.
* Document text is rendered as plain text or sanitised Markdown (raw HTML is never rendered).

## Database changes (migrations `0005`, `0006`)

New tables `documents`, `document_chunks`; new columns `conversations.document_id`,
`messages.action`, `messages.metadata`; column-level GRANTs; `documents_set_updated_at` trigger;
private bucket `notes` (10 MB, pdf/txt/md MIME types); storage policies
`notes_objects_select_own`, `notes_objects_insert_own`. Additive only; existing data untouched.

## Running locally

The API currently refuses to start because Google's current free-tier eligibility for the candidate model is unverified.
There is no Ollama, mock, or other-provider fallback. Do not make live AI requests to establish model eligibility; see
`AI_POLICY.md` and `FREE_AI.md`.

Design preview without any backend: `npm run dev -w @copilot/web` then `/dev/notes`
(fixtures only; removed from production builds, checked by `npm run verify:bundle -w @copilot/web`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| API refuses to start for AI policy | The model is not approved until its current free-tier eligibility is verified from official Google documentation |
| Gemini quota/access error | The request fails safely; no alternate provider is tried |
| "File storage is not configured" | `SUPABASE_URL` / `SUPABASE_ANON_KEY` missing in `.env` |
| Upload FAILED "no selectable text" | Scanned PDF: use a text-based PDF or paste the text |
| "You already uploaded this" | Same content hash exists; open the existing note via the link |

## Tests

* API: `npm test -w @copilot/api` (processing, service, routes, assistant, policy guards).
* Live DB (rolled back): `npm run test:integration -w @copilot/api` (RLS, storage policies, FTS).
* Web: `npm test -w @copilot/web` (library, upload, workspace, citations).
* Not automated: a real signed-in upload to hosted Supabase Storage (needs a real user session);
  verify manually after deployment.

## Phase 11 additions

- `GET /api/notes/:id/index-status` reports whether the document is searchable by the AI (derived from its real processing state; search method is keyword, no embeddings).
- A document question the document does not answer gets the "not in your notes" reply (no AI call); assistant replies now carry `grounding` and sources with the document's title.
- Scanned / image-only PDFs fail with the "scanned/image-only pages" message (no OCR).
- "Ask AI About This" opens the AI Tutor limited to the document. See `docs/KNOWLEDGE.md`.
