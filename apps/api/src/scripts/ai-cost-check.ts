import { EnvError, loadEnv } from "../config/env.js";
import { assessAiCost, formatCostReport } from "../services/ai/cost-safety.js";
import { createLLMProvider } from "../services/ai/index.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { OllamaProvider } from "../services/ai/ollama-provider.js";

/**
 * AI Cost Safety Check (zero-cost AI policy, docs/AI_POLICY.md).
 *
 *   npm run check:ai            report only: sends NO request of any kind
 *   npm run check:ai -- --live  one small request: to a local Ollama (or the mock); in free mode ONE request through the free chain
 *                               (the services you configured, in order - free tiers only, never paid)
 *
 * The report is printed first. Nothing is sent unless the result is SAFE, and a failure of
 * Ollama is reported as a failure: this script has no other provider to fall back to.
 */
async function main() {
  const env = loadEnv({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused",
    SUPABASE_URL: process.env.SUPABASE_URL ?? "https://unused.supabase.co",
  });

  const report = assessAiCost(env);
  console.log(formatCostReport(report));

  if (report.result !== "SAFE") {
    console.error("\nBLOCKED: no request was made. Explicit written approval is required before any paid or remote AI is used.");
    process.exit(1);
  }
  if (!process.argv.includes("--live")) {
    console.log(
  "\nReport only. No AI request was sent. Add --live to send one request through the configured free AI chain."
);
    return;
  }

  if (env.AI_PROVIDER === "free") {
    // Explicit --live only. ONE tiny request through the real chain: no retries, nothing stored, no student data.
    const chain = createLLMProvider(env);
    console.log("\nSending ONE tiny request through the free chain (this may contact the free online service you configured) ...");
    const started = Date.now();
    try {
      const result = await chain.generateText({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 400 }); // room for a "thinking" model to finish thinking
      console.log(`Response after ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.text.slice(0, 120)}`);
    } catch (err) {
      console.log(`No answer: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    const status = await chain.status?.();
    if (status) {
      console.log(`\nAnswered by: ${status.lastAnswered ? `${status.lastAnswered.service} (${status.lastAnswered.model})` : "nobody (every service failed)"}`);
      for (const step of status.steps) {
        const limit = step.limitPerDay !== null ? ` of ${step.limitPerDay}/day` : "";
        console.log(`  ${step.order}. ${step.service} [${step.model}] ${step.state}, asked ${step.usedToday}${limit}, last result: ${step.lastResult ?? "not asked"}`);
      }
    }
    return;
  }

  const provider =
    env.AI_PROVIDER === "mock"
      ? new MockProvider(0)
      : new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_MODEL, timeoutMs: env.AI_TIMEOUT_MS, numCtx: env.OLLAMA_NUM_CTX });
  console.log(`\nSending ONE request to ${env.AI_PROVIDER === "mock" ? "the in-process mock" : `${env.OLLAMA_BASE_URL} (this machine)`} ...`);
  const result = await provider.generateText({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 20 });
  console.log(`Response (${result.model}, mock=${result.isMock}): ${result.text.slice(0, 200)}`);
}

main().catch((err) => {
  if (err instanceof EnvError) console.error(err.message);
  else if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "local_unavailable") {
    console.error("\nLocal AI (Ollama) is not running, so there is no live result. Start Ollama and run `ollama pull <model>`. Nothing else was contacted.");
  } else console.error(`ai check failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
});
