# AI provider and privacy policy

## Required policy

- Google Gemini is the only intended online AI provider. The active API factory does not select Ollama, a local model, a mock fallback, Groq, OpenRouter, or a paid provider.
- There is no automatic provider switching. A Gemini quota, network, or provider error is returned to the user as an error.
- AI credentials are backend-only and must never be put in frontend variables, logs, API responses, documentation, or source control.
- The application is for adults (18+) and professional/business use only. Do not offer Gemini-powered features to under-18 users.

## Current availability: explicitly disabled by default

`AI_ENABLED` defaults to `false`. In that mode, the API starts without an AI provider, no prompts or study content are sent externally, and generative AI routes return a clear `503 unavailable` response. The admin and health status screens report that AI is disabled. This allows the non-AI application to run without suggesting AI works.

`gemini-3.5-flash-lite` is approved in `services/ai/free/catalog.ts`: Google's pricing documentation currently lists its token input and output as free of charge on the Free tier. Free-tier quotas and availability are account-specific and may change. This does not make the model free on a paid-tier project.

To keep usage free, Google Cloud billing must be disabled on the project associated with the Gemini key. Verify this in Google Cloud before setting `GEMINI_BILLING_DISABLED=true`; this value is only an operator attestation, and the application cannot inspect Google Cloud billing state. If billing is enabled, or this cannot be verified, keep `AI_ENABLED=false`. Once enabled, quota exhaustion returns an error and never falls back to another provider. If startup checks fail, the API refuses to start.

## Data sent for AI processing

When AI is enabled, user prompts and relevant study content (which can include note passages, quiz or viva details, planner data, and answers) may be transmitted to Google Gemini for processing. Google states in the Gemini API pricing/terms for unpaid service that submitted prompts and responses may be used to improve its products; Google's terms also allow human review in applicable circumstances. The app does not claim that Google never stores or uses submitted content. Users should not submit sensitive personal information.

This disclosure is shown in Settings and on the sign-in/sign-up experience. User-data isolation in this application does not prevent content in an AI request from being sent to Google.

## Configuration and checks

- `.env.example` contains variable names only and no credentials. Set `GEMINI_API_KEY` only in the backend's secret store.
- `AI_ENABLED` accepts only `true` or `false` and defaults to `false`. When disabled, provider settings are ignored and no provider is constructed. To enable free-tier Gemini, set `AI_PROVIDER=gemini`, `GEMINI_MODEL=gemini-3.5-flash-lite`, a server-side `GEMINI_API_KEY`, and `GEMINI_BILLING_DISABLED=true` only after verifying billing is disabled. Missing or invalid configuration blocks startup.
- `npm run check:ai` is a report-only check and makes no AI request. Do not use its opt-in live mode for policy verification.
- Tests must use mocked responses only. Never print keys, inspect `.env` contents, or make a live request to verify model/quota behavior.

## Official sources checked

- [Gemini API model guide](https://ai.google.dev/gemini-api/docs/models)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)

Re-check these sources before changing the approved model or its free-tier status. The Google project billing setting must be verified separately.
