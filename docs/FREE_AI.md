# Gemini free-tier setup

Google Gemini is the sole intended AI provider. There is no local-model execution and no fallback to Ollama, Groq, OpenRouter, mock, or a paid provider. A quota or provider failure must produce a clear error rather than switching services.

## Model pricing verified; deployment remains disabled pending billing check

`gemini-3.5-flash-lite` is approved in the runtime model allowlist. Google's current pricing documentation lists its token input and output as free of charge on the Free tier. Free-tier quotas are account-specific and may change. A paid-tier project has separate prices and is not free.

Official sources:

- [Gemini API model guide](https://ai.google.dev/gemini-api/docs/models) - lists model IDs and availability.
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) - model details.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) - current free and paid tier pricing.
- [Gemini API terms](https://ai.google.dev/gemini-api/terms) - terms for API use and submitted content.

Google's unpaid-tier terms say submitted prompts and responses may be used to improve products and may be subject to human review. Do not claim that Google never stores or uses submitted content. The application is intended only for adults 18+ and professional/business use.

## Configuration

The backend uses these variables. No key belongs in the browser, a `VITE_*` variable, Git, logs, or API responses:

```dotenv
AI_ENABLED=false
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_BILLING_DISABLED=false
```

Keep AI disabled until you verify in Google Cloud that billing is disabled for the project associated with the API key. Only then set `AI_ENABLED=true` and `GEMINI_BILLING_DISABLED=true`. The latter is an operator attestation only; the app cannot verify Google's billing settings. If free-tier quota is exhausted, the API returns an error; it does not select another provider. Do not enable billing on this project.

`npm run check:ai` reports configuration only and sends no AI request. Tests use mocked HTTP responses only; no live provider request is needed or permitted to establish eligibility.
