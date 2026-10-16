import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** Closes the connection pool. */
  close: () => Promise<void>;
}

/**
 * Creates the Drizzle client for Supabase Postgres.
 * - `prepare: false` keeps it compatible with Supabase's transaction pooler (port 6543).
 * - TLS is required for hosted Supabase.
 * Connections are opened lazily on first query, so creating the handle never fails.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, {
    prepare: false,
    ssl: "require",
    max: 5, // Supabase session pooler has few client slots; keep the footprint small
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export interface DbPing {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** Round-trips `select 1` through Drizzle. Returns a generic error string (no driver details). */

/** Round-trips `select 1` through Drizzle and logs safe diagnostic details on failure. */

/** Read-only database connectivity check with nested error diagnostics. */
export async function pingDb(db: Database): Promise<DbPing> {
  const started = performance.now();

  try {
    await db.execute(sql`select 1`);

    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (err: unknown) {
    let current: unknown = err;
    const diagnostics: Array<{
      name?: string;
      code?: string;
      message?: string;
    }> = [];

    // Inspect nested errors without logging connection strings or credentials.
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      const e = current as Error & {
        code?: string;
        cause?: unknown;
      };

      diagnostics.push({
        name: e.name,
        code: e.code,
        message: e.message.split("\n")[0],
      });

      current = e.cause;
    }

    console.error("Database diagnostic:", diagnostics);

    return {
      ok: false,
      latencyMs: null,
      error: "Database unreachable",
    };
  }
}

