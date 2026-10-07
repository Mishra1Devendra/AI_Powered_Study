# Free AI chain (local first, then approved free online services - never paid)

Project rule (owner, 2026-10-06): **free AI only. Never paid, never a card, never a paid fallback. Prefer failure over spending.**
The only email to register with anywhere is **devendramishra2004@gmail.com**. No payment details are ever entered.

## How it works

Set `AI_PROVIDER=free` in the server `.env`. For every AI request a student starts:

```
local Ollama (llama3.2:3b)  ->  free service #1  ->  #2  ->  #3  ->  "All free AI services are currently unavailable. Please try again later."
```

* A service that is rate-limited, out of free quota, down, slow or unauthorised is **skipped** and the next free one is tried. Each service is tried **at most once per request** (no retries, no loops), and only when a student asked. A failed service rests for 30 s - 10 min so it is not asked again on every request.
* Fallback happens only **before the first word** of a reply. A reply that has started is never silently restarted somewhere else.
* If the local model is running it always answers first; nothing leaves the computer.
* There is **no paid service in the chain**, so there is nothing paid to fall back to. When every free service fails the student sees the plain message above (no demo text, no charge).
* `AI_PROVIDER=ollama` (the default) keeps the old behaviour: local Ollama, then the labelled demo AI. `AI_PROVIDER=mock`: demo only.

## The approved list, in the default order (`FREE_AI_ORDER=groq,openrouter,gemini`)

Verified from each provider's official documentation on 2026-10-06. Re-verify before changing anything: free terms change.

| # | Service | Approved model(s) | Free tier | Card | Over the free limit | Notes |
|---|---|---|---|---|---|---|
| 1 | Groq | `openai/gpt-oss-20b` (default), `openai/gpt-oss-120b` | Free plan with rate limits (about 30 requests/min, 1,000 requests/day for these models) | No (per Groq's sign-up) | HTTP 429, no charge | Fast. |
| 2 | OpenRouter | an explicit model id **ending in `:free`**, chosen by you in `OPENROUTER_MODEL` (no default: the free list changes) | `:free` models: 20 requests/min, 50 requests/day while you have bought no credits | No | HTTP 429; "free models cannot be billed" | Never use a router/auto id or an id without `:free`; the app refuses them. A negative credit balance can block even free models (never buy credits). |
| 3 | Google Gemini | `gemini-3.5-flash-lite` (default); also `gemini-3.5-flash`, `3.6`, `3.7`, `3.8-flash`, `2.5-flash` (all "Free of charge" on Google's pricing page, 2026-10-06). `gemini-2.5-flash-lite` is no longer offered to new keys | Free tier in AI Studio | No | HTTP 429 | **Free-tier content may be used by Google to improve its products** (their pricing page), so it is last. Create the key in a Google project **without billing** and never enable billing on it - the code cannot check that for you. |

**Not used** (could not be confirmed free from official pages, so by the "any doubt - do not use" rule): Cloudflare Workers AI (free plan stops with an error after 10,000 neurons/day, but which models are free could not be confirmed), Mistral (Experiment plan: official page unreachable; data may be used for training), Cerebras (sources disagree on whether a payment method is needed), Hugging Face (credit based). To add one: verify the exact model, that no card is needed, and what happens when the allowance ends; then add it to `services/ai/free/catalog.ts` and the guard tests.

## Setting it up (you do this; the assistant cannot create accounts or keys)

1. Sign up for each service you want, **with devendramishra2004@gmail.com**, on its free plan only. Skip any step that asks for a card or billing - if a service insists, do not use that service.
2. Create an API key and put it in the **server** `.env` (never in the web app, Git, docs or screenshots):

```
AI_PROVIDER=free
FREE_AI_ORDER=groq,openrouter,gemini
GROQ_API_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=<a model id ending in :free>
GEMINI_API_KEY=...
```

3. Leave any key empty to skip that service. Run `npm run check:ai`: it must say **SAFE**, show only the services you set (key *names*, never values) and "Paid or Free: Free".
4. Restart the API.

## Keeping the services unseen

* Keys live only in the server environment. They are sent only in a request header to a fixed, hard-coded host; they are never in a URL, an error message, a log line or an API response (log text is scrubbed for key shapes; tests cover this).
* Students and the browser never learn *which* online service answered: results carry the opaque label `free-ai` / `free-online-ai`; the web app contains no service names (a test scans for them). Settings says only that a free online service may be used when the local AI is not running.
* There are no endpoint or URL settings for these services, so nobody can point them elsewhere.
* Server logs identify AI calls as `free-ai` and never include keys or content.

## Honest limits

* When a free online service answers, the student's question and any note passages sent with it **leave the computer**. Groq says it does not train on API data; OpenRouter's free models and Gemini's free tier may use content for improvement/training. Tell students (Settings already says an online service may be used) and avoid using the chain for sensitive material.
* Free quotas are small (OpenRouter: 50 requests/day). Quiz and plan generation make several calls, so a quota can run out mid-way; the app then stops with the plain message rather than paying.
* The chain adds no AI call sites: every call still comes from a student action (see `policy.guard.test.ts`).
