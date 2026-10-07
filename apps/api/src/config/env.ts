import { DEFAULT_AI_DAILY_UNITS } from "@copilot/shared";
import { z } from "zod";

/** Empty strings in `.env` (e.g. `ANTHROPIC_API_KEY=`) are treated as "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  /** "true" only when the API sits behind a reverse proxy you control (it then trusts X-Forwarded-For for the client address). */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),

  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required (see .env.example)" })
    .min(1, "DATABASE_URL is required (see .env.example)")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must start with postgresql://"),

  SUPABASE_URL: z
    .string({ required_error: "SUPABASE_URL is required (see .env.example)" })
    .url("SUPABASE_URL must be a valid https URL"),
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  // ZERO-COST AI POLICY (docs/AI_POLICY.md): the only allowed providers are a LOCAL Ollama server
  // and the demo mock. Paid/cloud providers are disabled; there is no provider chain.
  AI_PROVIDER: z
    .enum(["ollama", "mock", "free"], {
      errorMap: () => ({
        message:
          "must be 'ollama', 'mock' or 'free' (local AI first, then the approved FREE online services). Paid AI providers are disabled by project policy and need the owner's explicit written approval.",
      }),
    })
    .default("ollama"),
  // Free online services (only used when AI_PROVIDER=free). Server-side secrets: never sent to the browser, never logged.
  // Models must be on the approved-free list in services/ai/free/catalog.ts; there are no endpoint variables on purpose.
  FREE_AI_ORDER: optionalString,
  /** "first" (default): local AI answers first, free online services are the backup. "last": free online services first, local AI last. */
  FREE_AI_LOCAL_POSITION: z.enum(["first", "last"], { errorMap: () => ({ message: "must be 'first' or 'last'" }) }).default("first"),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: optionalString,
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_MODEL: optionalString,
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2:3b"),
  /** Context window requested from Ollama (its own default is small and silently truncates). */
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(131072).default(8192),
  /** Daily AI allowance of every non-admin account, in "uses" (a tutor reply is 1, a quiz 3; see AI_COST in the shared package). Administrators are never limited. */
  AI_DAILY_UNITS: z.coerce.number().int().min(1).max(100_000).default(DEFAULT_AI_DAILY_UNITS),
  /** Local models can be slow on a CPU, especially on first load. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {}

/** Validates the environment. Error messages name the variable only, never its value. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new EnvError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
