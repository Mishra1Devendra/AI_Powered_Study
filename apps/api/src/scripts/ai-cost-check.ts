import { EnvError, loadEnv } from "../config/env.js";
import { assessAiCost, formatCostReport } from "../services/ai/cost-safety.js";
import { createLLMProvider } from "../services/ai/index.js";

/**
 * AI Cost Safety Check (zero-cost AI policy, docs/AI_POLICY.md).
 *
 *   npm run check:ai            report only: sends NO request of any kind
 *   npm run check:ai -- --live  one small request to the configured Gemini model
 *
 * The report is printed first. Nothing is sent unless the result is SAFE.
 * A failure is reported directly; this script has no other provider to fall back to.
 */
async function main() {
  const env = loadEnv({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused",
    SUPABASE_URL: process.env.SUPABASE_URL ?? "https://unused.supabase.co",
  });

  if (!env.AI_ENABLED) {
    console.log("AI is disabled for this deployment. No AI request was made.");
    return;
  }

  const report = assessAiCost(env);
  console.log(formatCostReport(report));

  if (report.result !== "SAFE") {
    console.error("\nBLOCKED: no request was made. Check the Gemini key/model and confirm project billing is disabled.");
    process.exit(1);
  }
  if (!process.argv.includes("--live")) {
    console.log("\nReport only. No AI request was sent. Add --live to send one request to Google Gemini.");
    return;
  }

  const provider = createLLMProvider(env);
  console.log("\nSending ONE tiny test request to Google Gemini ...");
  const result = await provider.generateText({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 20 });
  console.log(`Response (${result.model}, mock=${result.isMock}): ${result.text.slice(0, 200)}`);
}

main().catch((err) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error(`ai check failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
});
