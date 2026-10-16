# Knowledge Grounding (Phase 11)

The AI uses the student's **own uploaded study material** as context and says plainly when the material does not contain the answer.
When enabled, prompts and relevant note passages may be sent to Google Gemini; the current candidate model's free-tier eligibility is
unverified, so the API is presently blocked from starting. See `AI_POLICY.md` for the privacy notice and status.

```
Upload -> Storage -> Extract -> Clean -> Chunk -> Store chunks (Postgres) -> Index (full-text)
   question -> search words -> retrieve relevant chunks -> one Gemini request (when enabled) -> answer + real sources
```

There is no local-model or alternate-provider fallback. Retrieval itself does not need a model.

## What was reused (nothing was duplicated)

| Existing | Used for |
| --- | --- |
| `documents`, `document_chunks` (+ `search_tsv` GIN index) | the store **and** the index - no new document/chunk tables |
| Notes pipeline (`extract` -> `normalize` -> `chunker` -> `saveChunksAndMarkReady`) | unchanged; chunks already carry real `page` / `heading` metadata |
| `LLMProvider` | shared application interface; the active API factory is Gemini-only |
| `createTurn` (streamed, validated, persisted reply) | Tutor and Notes assistant; gained a "fixed reply" path for "not in your notes" |
| `selectContext` / `extractKeywords` (`notes/retrieval.ts`) | the Notes assistant keeps its document-wide actions; keywords are shared |
| Quiz notes sources + per-question `source_ref` | already grounded and cited; only the picker changed |
| Auth, `withUser` (RLS), ownership checks, soft delete | every retrieval query |

## Retrieval architecture (and why it is keyword search)

`knowledge/service.ts` -> `retrieveRelevantChunks(userId, { query, documentId?, documentIds?, limit?, budgetChars?, minCoverage? })`

1. **Search words**: lowercase 3+ letter words, stop-words removed (shared `extractKeywords`).
2. **PostgreSQL full-text search** over the student's *ready, non-deleted* documents (`to_tsquery('english', ...)` with the words OR-ed;
   words are reduced to letters/digits so no query syntax can get in). Always filtered by the verified user id **and** Row Level Security.
3. **Lightweight keyword boost / relevance gate**: each candidate is re-scored by how many of the question's words it really contains
   (word-start match, so `engines` matches `engine`). A passage must contain at least **60%** of the question's words to count as
   "in your notes" - one shared word is not enough. Score = 0.7 x coverage + 0.3 x normalised full-text rank.
4. **Top 3-8 passages** (default 5, never more than 8) within a **6,000-character** budget. Whole documents are never sent.
5. **One retrieval + one generation per question.** No model call per chunk. No embeddings are computed on a question.

**Vector search is not used.** The `vector` (pgvector 0.8.2) extension is *available* in this Supabase project but is **not installed**. Per the phase rules nothing was downloaded and the extension was not enabled.
`retrieveRelevantChunks` is the single seam where vector search could be added later (store embeddings per chunk, embed once at index
time, never on every question) without touching Tutor, Quiz, Viva, Notes or Recommendations.

## Document states

`uploading` -> `processing` -> `ready` | `failed` (existing). The text is stored and the full-text index (a generated column on the
same row) is updated **in the same transaction** that marks the document `ready`, so "ready" means "searchable" - there is no separate
half-indexed state, and none is invented. The UI shows only what is true (`GET /api/notes/:id/index-status`, and `Note.indexed`):

- Uploading... / Preparing your study material: extracting text and creating the knowledge index... (no percentages)
- Ready: Uploaded - Text extracted - Indexed - "AI-ready: AI can now answer questions from this document."
- Failed: "We couldn't prepare this document." + the reason + **Retry** (existing `POST /api/notes/:id/process`).
- Scanned / image-only PDF: "This document appears to contain scanned/image-only pages. Text-based AI grounding is not available for
  this document yet." There is **no OCR**. Existing limits are unchanged (10 MB, 300 pages, 1,500 chunks).

## Tutor

`POST /api/tutor/conversations/:id/messages` accepts two optional fields: `documentId` (ask about one of *your* documents; verified on
the server - another student's id is a 404 and nothing is saved) and `grounding: "general"` ("Explain generally").

| Situation | What happens | Saved on the reply |
| --- | --- | --- |
| Relevant passages found | one Gemini request with the passages in a fenced `<study_material>` block; sources returned | `grounding: grounded`, `sources[]` |
| Asked about a chosen document, or said "my notes / my pdf...", and nothing relevant | **No AI call.** "I couldn't find this topic in your uploaded material. I can still explain it using general knowledge." + **Explain generally** | `grounding: not_found`, model `knowledge-index`, no sources |
| "Explain generally" | one Gemini request, told to label it as general | `grounding: general` |
| Ordinary question, nothing relevant (or no documents) | an ordinary tutor turn, exactly as before | none |
| Follow-up with few distinctive words ("explain that again") | reuses the passages of the previous grounded answer | `grounded` |

A search failure never blocks an ordinary tutor answer. "Regenerate" keeps a general explanation general and a grounded answer on its document.

## Source references

Built **by the server from stored chunk metadata** - never by the model: `"Thermodynamics.pdf - Page 14"`, or `"... - Section: Entropy"`,
or just the document name. A Markdown/TXT file has no pages, so none is shown. The model's `[S1]` labels are for its own text only.

## Prompt-injection boundary

Layers, in order: **system instructions -> student context / mode -> grounding rules -> `UNTRUSTED` study material (last)**; the student's
question is a separate user message. Uploaded text is fenced (`</study_material` inside a document is escaped so it cannot close the block),
the rules say it is data and must never be followed, and the model's output is only ever shown - it can't trigger any action.
The system prompt, environment, keys and database credentials are never part of any response.

## Quiz, Viva, Recommendations

- **Quiz**: source = *General knowledge* / *My notes* (pick up to 5, or "Use all my notes") / *Specific document*. Notes quizzes already
  retrieve passages first, accept a question only if it passes the existing quality gate against those passages, and store a per-question
  source (shown in the review). A specific-document quiz uses that document only.
- **Viva** (`POST /api/viva/sessions`): optional `sourceType` (`general` default | `notes` | `document`) and `documentId`. Each question is
  based on **one real passage** (a different one each time when possible); the passage reference is stored as metadata
  (`viva_questions.source_ref`) and shown as "Based on: ..." without the answer. The evaluation receives the same passage as an *advisory*
  reference - a 3B model grades leniently and this is not authoritative. Nothing relevant -> a plain 422 "I couldn't find relevant
  information in this material." and **no AI call**; it never silently falls back to general knowledge.
- **Recommendations**: a "Review notes" action is added only when a ready document of the student really has a passage containing **all**
  the topic's words (one database statement). "Ask Tutor" and the other actions are unchanged; no association is ever invented.

## Database (additive only - migration `0013_viva_knowledge_source`)

`viva_sessions.source_type` (default `general`), `viva_sessions.document_id` (+ composite FK `(document_id, user_id)` -> `documents`,
check constraints, index), `viva_questions.source_ref` (jsonb, hidden from the students' database role like `key_points`).
Existing rows and behaviour are unchanged. No table, column, policy or row was dropped, truncated or rewritten; RLS is unchanged.

## Security

Every retrieval takes the verified user id (never from the request), filters on it, runs under RLS and joins `documents` on the same
owner. A document/chunk id from the client is verified; another student's id behaves like one that does not exist. Tests: unit
(in-memory), route-level, and **live-database** (real SQL + RLS, always rolled back).

## Known limitations

See the Phase 11 handoff. In short: keyword (not semantic) search - a question phrased with different words than the notes may miss;
no OCR; a 3B model can ignore citation instructions or grade viva answers leniently; the "asking about a document" scope lives in the
open tutor page (not saved on the conversation); the Tutor searches your documents on every message (one extra database query).
