# Deployment readiness (Phase 13)

**Status: documented only. Nothing has been deployed, and nothing in this repo deploys automatically.**
Read `docs/AI_POLICY.md` first: the AI is a *local* Ollama model with a labelled Mock fallback. Paid/cloud AI is not implemented and must not be added to make a deployment "work".

## 1. The pieces

| Piece | What it is | Where it runs |
|---|---|---|
| Web app | Static files built by Vite (`apps/web/dist`) | Any static host / CDN / the same server as the API |
| API | Fastify 5 (Node 22+), started with `tsx` | A Node host you control |
| Database + Auth + Storage | Supabase (Postgres, GoTrue, Storage) | Supabase (already hosted) |
| AI | Ollama + `llama3.2:3b` | **See section 5 - this is the hard part** |

## 2. Frontend

```bash
npm ci
npm run build -w @copilot/web      # tsc + vite build  -> apps/web/dist
npm run verify:bundle -w @copilot/web   # fails if a secret, an AI SDK or a dev-only screen is in the bundle
```

* Public values only: `SUPABASE_URL` and `SUPABASE_ANON_KEY` (RLS protects the data, these are not secrets). The web build never reads the service-role key or any AI setting.
* The web app calls **relative** URLs (`/api/...`). There is no `VITE_API_URL`. In production the static host and the API must therefore be reachable on the **same origin** (a reverse proxy that sends `/api/*` to the API and everything else to `index.html`). Without that, every request fails. This is the single most likely deployment mistake.
* The API registers no CORS plugin on purpose (same-origin only). `WEB_ORIGIN` exists in the env schema but is not used for CORS today.
* Single-page app: configure the host to answer unknown paths with `index.html` (client-side routes such as `/notes/...`).
* The app ships a web manifest (installable) and **no service worker**: it does not work offline and does not claim to.

## 3. Backend

```bash
npm ci
npm run start -w @copilot/api      # tsx src/server.ts, reads ../../.env if present
```

Environment variables (see `.env.example`; real values go in the host's secret store, never in Git):

| Variable | Secret? | Notes |
|---|---|---|
| `NODE_ENV` | no | `production` in production (quiet request logging, no stack traces to clients) |
| `API_HOST`, `API_PORT` | no | bind `127.0.0.1` behind the proxy; expose only the proxy |
| `TRUST_PROXY` | no | `true` only behind your own reverse proxy (`deploy/Caddyfile`, `deploy/nginx.conf`); default `false`. Without it every student shares the proxy's address and its rate limit |
| `DATABASE_URL` | **yes** | Supabase Session pooler URL (IPv4, supports migrations) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | no (public) | JWTs are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | currently unused; leave empty |
| `AI_PROVIDER` | no | `ollama` (default) or `mock`. Nothing else is accepted |
| `OLLAMA_BASE_URL` | no | must be loopback (`127.0.0.1`/`localhost`). Remote hosts are refused by design |
| `AI_DAILY_UNITS` | no | daily AI allowance per non-admin account (default `100`; see `docs/AI_LIMITS.md`). Administrators are never limited |
| `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `AI_TIMEOUT_MS` | no | `llama3.2:3b`, `8192`, `180000` |

`ANTHROPIC_BASE_URL` (or any other provider URL/key) is **not** read by the application and must not be set.

Health checks (for a load balancer / uptime monitor; neither calls the AI model):

* `GET /api/health` - the process is up.
* `GET /api/health/ready` - a database round-trip only (200 `ok` / 503 `degraded`). Deliberately public and minimal: no timings, no driver text, no AI model name and no call to the AI server. AI reachability, models and limits are on the admin AI-status page (`/admin/ai`).

Logging: structured JSON (pino). Request lines carry method, path (no query string) and request id. Errors are scrubbed (JWTs, Bearer tokens, DB URLs, `key=value` secrets, SQL parameters). Passwords, tokens, keys, note text, questions and answers are never logged. AI calls log one `ai_call` line (operation, provider, model, durations, token counts, ok/error code) and no content.

Process management: run under systemd / pm2 / a container with a restart policy. The server shuts down cleanly on SIGTERM; an uncaught exception logs a fatal line and exits (the supervisor restarts it).

## 4. Database

* Migrations are SQL files in `apps/api/drizzle/` (0000-0019), **additive only**. Apply with `npm run db:migrate -w @copilot/api` against the target database. Never reset, drop or truncate; never edit an applied migration - add a new one.
* Row Level Security is ON for every student-data table; the `authenticated` role has SELECT-only grants (column-level, so quiz answer keys and viva key points are unreadable by students); all writes go through the API's privileged connection with server-derived user ids.
* Storage: bucket `notes` is private, 10 MB limit, `application/pdf`, `text/plain`, `text/markdown`; policies restrict each student to the folder named after their own user id. Files are served only through the API (no public URL).
* Supabase advisor: the only open warning is "leaked password protection disabled" (a dashboard setting - enabling it is a product decision and is left to the owner).
* Backups: use Supabase's own backup/PITR for the project; this repo adds none.

## 5. The AI - an honest decision is required before real users

The app can only use an Ollama running on the **same machine as the API** (loopback rule). That gives three realistic setups:

| Option | Works today? | Cost | Reality check |
|---|---|---|---|
| **A. Local / student machine** - each student runs the app and Ollama on their own computer | Yes (this is the tested setup) | ₹0 | Needs a laptop able to run a 3B model (about 4 GB free RAM; CPU generation is slow - see the timings in the Phase 13 report). Not a "hosted website" experience. |
| **B. Server-hosted local model** - one server runs the API *and* Ollama | Yes technically | Server cost (a CPU/GPU box) | Several students share one small model; generations queue behind each other (the app already refuses concurrent generation per conversation but has no global queue). Needs capacity planning and a load test that this phase did not do. |
| **C. Future paid cloud AI** | **Not implemented, on purpose** | Per-use cost | Violates the current zero-cost policy. It would need a deliberate policy change, a new provider, cost caps and consent. Nothing in the code can do this today. |

Until option B is sized and tested, the honest hosted configuration is: deploy web + API, leave Ollama unavailable, and every AI feature runs on the **labelled Mock** (users see "Demo" markers). That is safe and free but is not real tutoring.

## 6. Pre-release checklist

- [ ] Same-origin reverse proxy with HTTPS: use `deploy/Caddyfile` or `deploy/nginx.conf` (`/api` -> API, everything else -> `dist/index.html`, security headers + CSP). Run `npm run build -w @copilot/web`, then `npm run csp:hash -w @copilot/web` and paste the hash into the CSP; set `TRUST_PROXY=true` on the API.
- [ ] `NODE_ENV=production`; `.env` only on the host; no secrets in Git (`.gitignore` excludes `.env`).
- [ ] `npm run db:migrate` run against the target database; `npm run check:db` passes.
- [ ] `npm run verify:bundle` passes on the exact build being shipped.
- [ ] `npm run check:ai` shows Ollama/Mock only and 0 paid requests.
- [ ] Decide A / B / Mock-only for the AI (section 5) and tell users which one they get.
- [ ] Supabase Auth: set the site URL/redirects for the real domain; decide on leaked-password protection and email confirmation.
- [ ] A monitor on `/api/health/ready`.
- [ ] The repository has **no commits yet** - make the first commit (review `git status`; `.env` must be untracked) before any CI/CD is attached.

## 7. Not done / out of scope for this phase

No deployment, no CI/CD pipeline, no containerisation, no CDN, no load test, no browser-level automated end-to-end suite, no global AI request queue.
