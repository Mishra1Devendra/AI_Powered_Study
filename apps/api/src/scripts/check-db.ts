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

    // Guard: every table in `public` must have Row Level Security enabled.
    const tables = await db.execute<{ name: string; rls: boolean; policies: string }>(sql`
      select c.relname as name, c.relrowsecurity as rls,
             (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname
    `);
    let rlsOk = true;
    for (const t of tables) {
      const good = t.rls && Number(t.policies) > 0;
      rlsOk &&= good;
      console.log(`      ${good ? "OK  " : "FAIL"}  public.${t.name}: RLS ${t.rls ? "on" : "OFF"}, ${t.policies} polic${t.policies === "1" ? "y" : "ies"}`);
    }
    if (!rlsOk) {
      console.error("FAIL  A public table is missing RLS or has no policies.");
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
