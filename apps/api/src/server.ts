import { buildApp } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { createDb } from "./db/client.js";
import { createDisabledLLMProvider, createLLMProvider } from "./services/ai/index.js";
import { withTelemetry, type AiLog } from "./services/ai/telemetry.js";
import { assessAiCost, formatCostReport } from "./services/ai/cost-safety.js";

async function main() {
  const env = loadEnv();

  let cost: ReturnType<typeof assessAiCost> | undefined;
  let aiProvider;
  if (env.AI_ENABLED) {
    // Fail safely before serving requests unless the sole Gemini provider is configured correctly. This check sends no AI request.
    cost = assessAiCost(env);
    console.log(formatCostReport(cost));
    if (cost.result !== "SAFE") {
      throw new EnvError(
        `Refusing to start: the Gemini AI configuration is ${cost.result}. Check the key, verify the model's current free-tier eligibility, and confirm the Google project's billing is disabled.`,
      );
    }
    aiProvider = createLLMProvider(env);
  } else {
    console.log("AI is disabled for this deployment; no AI requests will be made.");
    aiProvider = createDisabledLLMProvider();
  }

  const { db, close } = createDb(env.DATABASE_URL);
  let log: AiLog = { info: () => undefined, warn: () => undefined };
  // Every AI call is timed and counted (never its content). The wrapper only forwards calls the application already makes.
  const ai = env.AI_ENABLED
    ? withTelemetry(aiProvider, { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m) })
    : aiProvider;
  const app = await buildApp({
    env,
    db,
    ai,
    verifyToken: createTokenVerifier(env.SUPABASE_URL),
    replyDeadlineMs: env.AI_TIMEOUT_MS,
  });

  log = app.log;
  if (cost && cost.paidKeysPresent.length > 0) {
    app.log.warn(`Paid AI credentials are present in the environment (${cost.paidKeysPresent.join(", ")}). They are ignored and never used.`);
  }
  app.log.info(ai.name === "disabled" ? "AI is disabled; no AI provider is configured or contacted." : `AI: Google Gemini API (${ai.model}); no alternate provider is configured.`);

  const shutdown = async () => {
    await app.close();
    await close();
    process.exit(0);
  };
  // A bug in background work must be visible in the logs, never a silent crash or a silent swallow.
  process.on("unhandledRejection", (reason) => app.log.error({ err: reason }, "unhandled promise rejection"));
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "uncaught exception; shutting down");
    void shutdown().finally(() => process.exit(1));
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err) => {
  if (err instanceof EnvError) {
    console.error(err.message);
  } else {
    console.error("Failed to start API:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
