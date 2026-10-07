import { buildApp } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { createDb } from "./db/client.js";
import { createLLMProvider } from "./services/ai/index.js";
import { withTelemetry, type AiLog } from "./services/ai/telemetry.js";
import { assessAiCost, formatCostReport } from "./services/ai/cost-safety.js";

async function main() {
  const env = loadEnv();

  // ZERO-COST AI POLICY: fail safely, before anything else starts, unless the configured AI is
  // provably free and local (or the mock). Nothing here sends an AI request.
  const cost = assessAiCost(env);
  console.log(formatCostReport(cost));
  if (cost.result !== "SAFE") {
    throw new EnvError(
      `Refusing to start: the AI configuration is ${cost.result}. Explicit written approval is required before any paid or remote AI is used. Set AI_PROVIDER=ollama (local) or AI_PROVIDER=mock.`,
    );
  }

  const { db, close } = createDb(env.DATABASE_URL);
  let log: AiLog = { info: () => undefined, warn: () => undefined };
  // Every AI call is timed and counted (never its content). The wrapper only forwards calls the application already makes.
  const ai = withTelemetry(createLLMProvider(env), { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m) });
  const app = await buildApp({
    env,
    db,
    ai,
    verifyToken: createTokenVerifier(env.SUPABASE_URL),
    replyDeadlineMs: env.AI_TIMEOUT_MS,
  });

  log = app.log;
  if (cost.paidKeysPresent.length > 0) {
    app.log.warn(`Paid AI credentials are present in the environment (${cost.paidKeysPresent.join(", ")}). They are ignored and never used.`);
  }
  if (ai.isMock) app.log.warn("AI_PROVIDER=mock: replies are canned demo output.");
  else app.log.info(`AI: local Ollama (${ai.model}); if it is not running, replies fall back to the labelled mock.`);

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
