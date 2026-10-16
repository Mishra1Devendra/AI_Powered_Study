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

  AI_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  AI_PROVIDER: z.string().default("gemini"),
  // Gemini credentials are server-only. The configured model must remain on the verified free-tier allowlist.
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  /** Operator attestation; the project billing state itself cannot be checked by this application. */
  GEMINI_BILLING_DISABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Daily AI allowance of every non-admin account, in "uses" (a tutor reply is 1, a quiz 3; see AI_COST in the shared package). Administrators are never limited. */
  AI_DAILY_UNITS: z.coerce.number().int().min(1).max(100_000).default(DEFAULT_AI_DAILY_UNITS),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
}).superRefine((env, ctx) => {
  if (env.AI_ENABLED && env.AI_PROVIDER !== "gemini") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_PROVIDER"],
      message: "must be 'gemini' when AI_ENABLED=true; no other AI provider or fallback is enabled",
    });
  }
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
