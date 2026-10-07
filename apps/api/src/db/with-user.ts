import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export type UserTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Runs `fn` in a transaction that behaves exactly like a PostgREST request from that user:
 * the role is switched to `authenticated` and `auth.uid()` resolves to `userId`, so Row Level
 * Security applies to every query inside. Both settings are transaction-local and revert on
 * commit/rollback, so pooled connections never leak identity between requests.
 *
 * The API connects with a privileged role that would otherwise bypass RLS - always use this
 * helper for per-user data so the database enforces isolation even if a query forgets a filter.
 */
export function withUser<T>(db: Database, userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`set local role authenticated`);
    const result = await fn(tx);
    // Explicit reset: a no-op for a top-level transaction (commit reverts it anyway) but makes
    // the helper safe when `db` is itself a transaction (savepoint), e.g. in rolled-back tests.
    await tx.execute(sql`reset role`);
    await tx.execute(sql`select set_config('request.jwt.claims', '', true)`);
    return result;
  });
}
