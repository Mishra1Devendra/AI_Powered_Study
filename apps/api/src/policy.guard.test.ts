import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ZERO-COST AI POLICY guard (docs/AI_POLICY.md). These are static checks over the repository so
 * a paid AI path, or an AI call nobody asked for, cannot be introduced by accident. If one of
 * these fails, STOP: the owner's explicit written approval is required for paid AI.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "drizzle"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}
const rel = (p: string) => relative(root, p).replaceAll("\\", "/");
const sourceFiles = [...files(join(root, "apps")), ...files(join(root, "packages"))].filter((p) => /\.(ts|tsx|mjs|json)$/.test(p) && !p.endsWith("package-lock.json"));
const productionSource = sourceFiles.filter((p) => /\/src\//.test(rel(p)) && !/\.(test|guard\.test)\.tsx?$/.test(p));

describe("zero-cost AI policy: dependencies", () => {
  const manifests = [join(root, "package.json"), ...sourceFiles.filter((p) => p.endsWith("package.json"))];
  const paidSdk = /^(@anthropic-ai\/|openai$|@google\/generative-ai$|@google\/genai$|@google-cloud\/vertexai$|@aws-sdk\/client-bedrock|cohere-ai$|@mistralai\/|groq-sdk$|ai$|@ai-sdk\/|langchain$|@langchain\/|replicate$|together-ai$|@huggingface\/inference$|@azure\/openai$)/;

  it("no paid/cloud AI SDK is a dependency of any workspace", () => {
    const offenders: string[] = [];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(m, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[group] ?? {})) if (paidSdk.test(name)) offenders.push(`${rel(m)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the lockfile contains no paid AI SDK either", () => {
    const lock = readFileSync(join(root, "package-lock.json"), "utf8");
    expect(lock).not.toMatch(/"node_modules\/(@anthropic-ai|openai|@google\/generative-ai|@google\/genai|@ai-sdk|langchain|groq-sdk|cohere-ai)/);
  });
});

describe("Gemini-only AI policy: source code", () => {
  it("references provider API hosts only in the fixed catalog", () => {
    const hosts = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime|openai\.azure\.com|api\.cohere\.|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|api\.x\.ai|api\.deepseek\.com|api\.together\.|api\.perplexity\.ai|api\.replicate\.com|ollama\.com/i;
    const offenders = productionSource.filter((p) => hosts.test(readFileSync(p, "utf8")) && rel(p) !== "apps/api/src/services/ai/free/catalog.ts").map(rel);
    expect(offenders).toEqual([]);
  });

  it("keeps provider origins fixed and approves only the verified Gemini free-tier model", () => {
    const catalog = readFileSync(join(root, "apps/api/src/services/ai/free/catalog.ts"), "utf8");
    const origins = [...catalog.matchAll(/origin: "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(origins).toEqual(["https://api.groq.com", "https://generativelanguage.googleapis.com", "https://openrouter.ai"]);
    expect(catalog).toMatch(/gemini:.*models: \["gemini-3\.5-flash-lite"\], defaultModel: "gemini-3\.5-flash-lite"/s);
    expect(catalog).not.toMatch(/api\.openai\.com|api\.anthropic\.com|aiplatform|bedrock|azure/i);
  });

  it("no provider endpoint can be configured in the environment", () => {
    const env = readFileSync(join(root, "apps/api/src/config/env.ts"), "utf8");
    expect(env).not.toMatch(/(GROQ|GEMINI|OPENROUTER)_(BASE_URL|ENDPOINT|API_BASE|HOST|URL)/);
  });

  it("the frontend contains no Gemini credential name, key, or direct provider endpoint", () => {
    const web = productionSource.filter((p) => rel(p).startsWith("apps/web/") && !rel(p).startsWith("apps/web/src/dev/"));
    const offenders = web.filter((p) => /GEMINI_API_KEY|AIza[0-9A-Za-z_-]{20,}|generativelanguage\.googleapis\.com/i.test(readFileSync(p, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
    const shared = productionSource.filter((p) => rel(p).startsWith("packages/shared/"));
    expect(shared.filter((p) => /GEMINI_API_KEY|AIza[0-9A-Za-z_-]{20,}|generativelanguage\.googleapis\.com/i.test(readFileSync(p, "utf8"))).map(rel)).toEqual([]);
  });

  it("no real API key is committed anywhere (source, docs, examples)", () => {
    const shapes = /\b(gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_\-]{30,}|sk-or-v1-[A-Za-z0-9]{20,})/;
    const candidates = [...sourceFiles, join(root, ".env.example"), ...[...files(join(root, "docs"))]].filter((p) => !/\.test\.tsx?$/.test(p));
    expect(candidates.filter((p) => shapes.test(readFileSync(p, "utf8"))).map(rel)).toEqual([]);
  });

  it("never reads a paid provider's API key or endpoint", () => {
    // cost-safety.ts is allowed to NAME them (to detect and report them); nothing may read them.
    const reads = /process\.env\.(ANTHROPIC|OPENAI|GEMINI|AZURE_OPENAI|COHERE|MISTRAL|GROQ|XAI|DEEPSEEK)_|process\.env\[['"`](ANTHROPIC|OPENAI)/;
    const offenders = productionSource.filter((p) => reads.test(readFileSync(p, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the active provider factory can only construct Gemini and has no local or alternate-provider fallback", () => {
    const factory = readFileSync(join(root, "apps/api/src/services/ai/index.ts"), "utf8");
    expect(factory).toMatch(/new GeminiProvider/);
    expect(factory).not.toMatch(/import\s+\{[^}]*\b(?:OllamaProvider|MockProvider|FreeAiChainProvider|ChatCompletionsProvider)\b|new\s+(?:OllamaProvider|MockProvider|FreeAiChainProvider|ChatCompletionsProvider|buildFreeSlots)\b/);
    const env = readFileSync(join(root, "apps/api/src/config/env.ts"), "utf8");
    expect(env).toMatch(/env\.AI_ENABLED && env\.AI_PROVIDER !== "gemini"/);
    expect(env).not.toMatch(/OLLAMA_|FREE_AI_ORDER|GROQ_API_KEY|OPENROUTER_API_KEY/);
  });

  it("no production module imports the retained local or alternate-provider adapters", () => {
    const legacy = new Set([
      "apps/api/src/services/ai/mock-fallback.ts",
      "apps/api/src/services/ai/mock-provider.ts",
      "apps/api/src/services/ai/ollama-provider.ts",
      "apps/api/src/services/ai/free/chain.ts",
      "apps/api/src/services/ai/free/chat-completions.ts",
    ]);
    const importsLegacy = /from\s+["'][^"']*(?:mock-fallback|mock-provider|ollama-provider|free\/chain|free\/chat-completions)\.js["']/;
    const offenders = productionSource.filter((p) => !legacy.has(rel(p)) && importsLegacy.test(readFileSync(p, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("keeps historical provider identifiers only for stored data compatibility", () => {
    const types = readFileSync(join(root, "apps/api/src/services/ai/types.ts"), "utf8");
    expect(types).toMatch(/export type ProviderName = "ollama" \| "mock" \| "free-ai" \| "disabled";/);
  });

  it("AI is only ever called for something a student asked for (no startup, scheduled or polling AI calls)", () => {
    const allowed = new Set([
      "apps/api/src/tutor/turn.ts", // the ONE call site: a reply the student asked for (tutor + notes)
      "apps/api/src/quiz/generate.ts", // the second call site: a quiz the student explicitly asked to generate (runs once per request, finishes after the HTTP response; never scheduled, polled or started by the server)
      "apps/api/src/planner/generate.ts", // the third call site: ONE call per study plan the student explicitly asked for (no per-day/per-session calls, no retries, never scheduled)
      "apps/api/src/viva/ai.ts", // the fourth call site: ONE question or ONE evaluation per student action in a viva (a single retry only for an unreadable reply; never scheduled, polled or started by the server)
      "apps/api/src/recommendations/explain.ts", // the fifth call site: ONE optional call when the student presses "Explain my priorities" (never on page load, scheduled, polled or retried; the recommendations themselves are deterministic)
      "apps/api/src/study-tools/generate.ts", // the sixth call site: ONE call per flashcard deck or mind map the student explicitly asked for (no retries, never scheduled or polled; capped per student per day)
      "apps/api/src/scripts/ai-cost-check.ts", // explicit report-only cost check; any live mode is never used by tests
      "apps/api/src/services/ai/mock-fallback.ts", // retained legacy provider plumbing; not imported by the active factory
      "apps/api/src/services/ai/mock-provider.ts",
      "apps/api/src/services/ai/ollama-provider.ts",
      "apps/api/src/services/ai/free/chain.ts",
      "apps/api/src/services/ai/free/chat-completions.ts",
      "apps/api/src/services/ai/free/gemini.ts", // sole provider adapter
      "apps/api/src/services/ai/telemetry.ts", // provider plumbing: a transparent wrapper that only forwards (and times) calls the app above already made
    ]);
    const calls = /\.(streamText|generateText)\(/;
    const offenders = productionSource.filter((p) => calls.test(readFileSync(p, "utf8")) && !allowed.has(rel(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("nothing schedules work (no cron/interval/timer-driven jobs) in the API", () => {
    const schedulers = /node-cron|node-schedule|setInterval\(|agenda|bullmq|bree/;
    const offenders = productionSource.filter((p) => rel(p).startsWith("apps/api/") && schedulers.test(readFileSync(p, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the frontend never calls an AI provider directly (only our own API)", () => {
    const web = productionSource.filter((p) => rel(p).startsWith("apps/web/") && !rel(p).startsWith("apps/web/src/dev/"));
    const offenders = web.filter((p) => /11434|ollama|anthropic|openai/i.test(readFileSync(p, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("env examples do not ask for paid AI credentials", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    // A comment may name the disabled providers; an actual credential/endpoint VARIABLE line may not.
    expect(example).not.toMatch(/^\s*#?\s*(ANTHROPIC|OPENAI|AZURE_OPENAI|AWS_BEDROCK|COHERE|MISTRAL|GOOGLE_API|GOOGLE_GENERATIVE)[A-Z_]*\s*=/im);
    // The three approved FREE services may appear, but never with a value filled in.
    for (const m of example.matchAll(/^\s*#?\s*(GROQ|GEMINI|OPENROUTER)_(API_KEY|MODEL)\s*=(.*)$/gim)) {
      if (m[2] === "API_KEY") expect(m[3]!.trim(), `${m[1]}_API_KEY must be empty in the example`).toBe("");
    }
    expect(example).toMatch(/^AI_PROVIDER=gemini/m);
  });
});
