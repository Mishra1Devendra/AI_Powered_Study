# Gemini free-tier verification status

Google Gemini is the sole intended AI provider. There is no local-model execution and no fallback to Ollama, Groq, OpenRouter, mock, or a paid provider. A quota or provider failure must produce a clear error rather than switching services.

## Model eligibility is unverified; AI is disabled

The candidate `gemini-2.5-flash-lite` is listed in Google's model guide. The official pricing page inspected did not conclusively establish that this exact model is currently available under the free tier. It is **not approved** in the runtime model allowlist, so API startup is blocked. Do not set a model or describe Gemini as confirmed free until the exact model's current eligibility is verified from official pricing documentation.

Official sources:

- [Gemini API model guide](https://ai.google.dev/gemini-api/docs/models) - lists model IDs and availability.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) - free access is limited to certain models.
- [Gemini API terms](https://ai.google.dev/gemini-api/terms) - terms for API use and submitted content.

Google's unpaid-tier terms say submitted prompts and responses may be used to improve products and may be subject to human review. Do not claim that Google never stores or uses submitted content. The application is intended only for adults 18+ and professional/business use.

## Configuration

The backend uses these variables. No key belongs in the browser, a `VITE_*` variable, Git, logs, or API responses:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=
GEMINI_BILLING_DISABLED=false
```

`GEMINI_BILLING_DISABLED=true` is an operator attestation only; the app cannot verify Google's billing settings. Do not enable billing on the Google project. A key, candidate model, or operator attestation does not by itself prove free-tier eligibility. Until official verification is completed, keep the model unset and expect startup/cost checks to fail closed.

`npm run check:ai` reports configuration only and sends no AI request. Tests use mocked HTTP responses only; no live provider request is needed or permitted to establish eligibility.
