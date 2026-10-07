import type { LoggerOptions } from "pino";

/**
 * Production-safe logging. Logs must let an operator find a failure (what, where, how long) WITHOUT becoming a second copy of
 * private data. So:
 *   - requests are logged by method and PATH only (the query string can hold search words or ids);
 *   - errors are logged by type, code and a scrubbed, shortened message - never the SQL parameters a driver error carries
 *     (they can include a student's document text or answers), never connection strings, tokens or JWTs;
 *   - authorization / cookie headers are redacted.
 */
const MAX_MESSAGE = 300;

/** Shapes of the free AI services' API keys, redacted from anything that could be logged. */
const AI_KEY_SHAPES = /\b(gsk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_\-]{20,}|sk-or-v1-[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_\-]{20,})/g;

/** Removes the parts of an error message that can carry private values. */
export function scrubMessage(message: string): string {
  return message
    .replace(/\bparams?:[\s\S]*$/i, "params: [omitted]") // Drizzle appends "params: <values>"
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, "[token]") // JWTs
    .replace(AI_KEY_SHAPES, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .replace(/\b(?:password|apikey|api_key|secret|token)\s*[=:]\s*\S+/gi, "$1=[omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  stack?: unknown;
  cause?: unknown;
}

/** The identifying parts of a (possibly nested) error, without values. */
export function safeError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") return { type: typeof err, message: scrubMessage(String(err)) };
  const e = err as ErrorLike;
  const cause = e.cause && typeof e.cause === "object" ? (e.cause as Record<string, unknown>) : null;
  const frames = typeof e.stack === "string" ? e.stack.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => l.trim()) : [];
  return {
    type: typeof e.name === "string" ? e.name : "Error",
    message: scrubMessage(typeof e.message === "string" ? e.message : ""),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.statusCode === "number" ? { status: e.statusCode } : typeof e.status === "number" ? { status: e.status } : {}),
    // The database error behind a failed query: its class and where, never `detail` (it quotes row values).
    ...(cause
      ? {
          cause: {
            ...(typeof cause.code === "string" ? { code: cause.code } : {}),
            ...(typeof cause.constraint_name === "string" ? { constraint: cause.constraint_name } : {}),
            ...(typeof cause.table_name === "string" ? { table: cause.table_name } : {}),
            ...(typeof cause.message === "string" ? { message: scrubMessage(cause.message) } : {}),
          },
        }
      : {}),
    ...(frames.length ? { stack: frames } : {}),
  };
}

interface ReqLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
}

export function safeRequest(req: ReqLike): Record<string, unknown> {
  const url = typeof req.url === "string" ? req.url : "";
  return { id: req.id, method: req.method, path: url.split("?")[0] };
}

export function buildLoggerOptions(nodeEnv: "development" | "test" | "production"): LoggerOptions {
  return {
    level: nodeEnv === "test" ? "silent" : "info",
    redact: ["req.headers.authorization", "req.headers.cookie", "headers.authorization", "headers.cookie"],
    serializers: { req: safeRequest, err: safeError },
  };
}
