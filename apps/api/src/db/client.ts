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
export async function pingDb(db: Database): Promise<DbPing> {
  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - started), error: null };
  } catch {
    return { ok: false, latencyMs: null, error: "Database unreachable" };
  }
}
