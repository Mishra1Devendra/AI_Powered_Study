import { sql } from "drizzle-orm";
import { EnvError, loadEnv } from "../config/env.js";
import { createDb, pingDb } from "../db/client.js";

/** Read-only connectivity check: select 1 via Drizzle, then basic server info. Changes nothing. */
async function main() {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    // The pooler can briefly refuse connections right after other clients disconnect; retry a few times.
    let ping = await pingDb(db);
    for (let attempt = 1; !ping.ok && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      ping = await pingDb(db);
    }
    if (!ping.ok) {
      console.error("FAIL  Drizzle could not reach PostgreSQL. Check DATABASE_URL (use the Session pooler string).");
      process.exitCode = 1;
      return;
    }
    console.log(`OK    Drizzle -> PostgreSQL round trip (${ping.latencyMs} ms)`);

    const info = await db.execute<{ db: string; version: string; tables: string }>(sql`
      select current_database() as db,
             split_part(version(), ' on ', 1) as version,
             (select count(*) from information_schema.tables where table_schema = 'public')::text as tables
    `);
    const row = info[0];
    if (row) console.log(`      database=${row.db}  server=${row.version}  public tables=${row.tables}`);

    // A table with no policies is safe only when neither client role has table- or column-level access.
    const tables = await db.execute<{ name: string; rls: boolean; policies: string; anonAccess: boolean; authenticatedAccess: boolean }>(sql`
      select c.relname as name, c.relrowsecurity as rls,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::text as policies,
             (
               has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
               or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE')
               or has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('anon', c.oid, 'REFERENCES')
               or has_table_privilege('anon', c.oid, 'TRIGGER')
               or has_any_column_privilege('anon', c.oid, 'SELECT') or has_any_column_privilege('anon', c.oid, 'INSERT')
               or has_any_column_privilege('anon', c.oid, 'UPDATE') or has_any_column_privilege('anon', c.oid, 'REFERENCES')
             ) as "anonAccess",
             (
               has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
               or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE')
               or has_table_privilege('authenticated', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'REFERENCES')
               or has_table_privilege('authenticated', c.oid, 'TRIGGER')
               or has_any_column_privilege('authenticated', c.oid, 'SELECT') or has_any_column_privilege('authenticated', c.oid, 'INSERT')
               or has_any_column_privilege('authenticated', c.oid, 'UPDATE') or has_any_column_privilege('authenticated', c.oid, 'REFERENCES')
             ) as "authenticatedAccess"
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname
    `);
    let rlsOk = true;
    for (const t of tables) {
      const clientAccess = t.anonAccess || t.authenticatedAccess;
      const good = t.rls && (Number(t.policies) > 0 || !clientAccess);
      rlsOk &&= good;
      const policyState = `${t.policies} polic${t.policies === "1" ? "y" : "ies"}`;
      const accessState = clientAccess ? "client grants present" : "no anon/authenticated grants";
      console.log(`      ${good ? "OK  " : "FAIL"}  public.${t.name}: RLS ${t.rls ? "on" : "OFF"}, ${policyState}, ${accessState}`);
    }
    if (!rlsOk) {
      console.error("FAIL  A public table has RLS disabled, or has client grants without an RLS policy.");
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof EnvError ? err.message : "check:db failed unexpectedly.");
  process.exit(1);
});
