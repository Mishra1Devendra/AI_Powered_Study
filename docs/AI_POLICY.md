# Zero-cost AI policy (permanent until the owner revokes it in writing)

AI Student Copilot must never use a paid AI service, API, model, token usage, subscription or credit.
AI cost target: **INR 0 / USD 0**. Paid AI is allowed only after the owner writes an explicit authorization
such as "I authorize paid Gemini usage". Phrases like "try it", "test it", "continue" or "use the best model"
are NOT authorization. When in doubt: stop, make no request, ask.

## What the code does about it

| Rule | Implementation |
|---|---|
| Default AI is Ollama on this device | `AI_PROVIDER=ollama`, `apps/api/src/services/ai/ollama-provider.ts` (plain local HTTP, no SDK) |
| Ollama down -> MOCK, never paid | `mock-fallback.ts`: its only target is the labelled mock; only when Ollama is unreachable before any output |
| Other failures are errors, not fake answers | timeouts, missing model, mid-reply loss are reported to the student |
| Paid providers cannot be selected | `AI_PROVIDER` accepts only `ollama` or `mock`; anything else fails at startup with an approval message |
| Ollama must be local | `OLLAMA_BASE_URL` must be loopback; Ollama **cloud** models (`...-cloud`) are refused |
| Paid keys are never used | no code reads them; they are only *detected* by name for reporting (`cost-safety.ts`) |
| Paid SDKs cannot sneak in | `policy.guard.test.ts` fails on any paid AI SDK, paid AI host, paid-key read, or AI call outside the allow-listed call sites (listed, each with its reason, in the test: tutor, quiz, planner, viva, recommendations, and flashcards / mind maps in `study-tools/generate.ts`) |
| No background AI | AI is called only because a student asked: a tutor/notes message, or "Generate quiz". A quiz finishes after the HTTP response (it takes minutes on a local model) but is never started by a timer, job, poll, startup or page refresh, makes at most a few bounded calls, and the provider never retries automatically |
| Safety check | `npm run check:ai` prints the cost report and sends nothing; `-- --live` sends ONE request, only to local Ollama or the mock |
| Fail safe at startup | the API refuses to start unless the AI configuration is `SAFE` |

## Using local AI (Ollama)

Ollama is **not installed by this project**. To use real local AI you install it yourself (it is free; no account,
no key): https://ollama.com/download, then pull a small model, for example `ollama pull llama3.2:3b`.
Until then, replies are clearly-labelled demo (mock) replies. Everything runs on your own device and uses its CPU/RAM.

## Zero-cost audit (run at the start and end of every phase)

`npm run check:ai` for the provider report, plus `npm test` (includes `policy.guard.test.ts`). Report format:

```
AI Cost Status
Provider / Model / Local-or-Cloud / Paid-or-Free / Billing enabled
Paid API key present / Paid API requests made / Potential charges
Result: SAFE | BLOCKED | NEEDS_APPROVAL
```

## What local inspection can and cannot prove

The project can show its **configuration and code paths**: which provider is selected, that no paid SDK or host
exists, and that no paid key is read. It **cannot** prove what an external provider's billing records say. "The
application never called a paid provider" is not the same statement as "the provider billed INR 0". See rules 14 and 15
in the policy; never claim INR 0 without provider-side evidence.

## Database safety still applies

This policy does not override database safety: no DROP, TRUNCATE, reset, deleting users/conversations/messages,
disabling RLS, or replacing Supabase without explicit approval.
