import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-database RLS test. Every statement runs inside ONE transaction that is always rolled
 * back, so no users, profiles or any other data are ever persisted. No real accounts are
 * created: two synthetic rows are inserted into auth.users inside that transaction only.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ROLLBACK = new Error("rollback");
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      await fn(tx);
      throw ROLLBACK;
    }),
  ).rejects.toBe(ROLLBACK);
}

/** Switch the current transaction to behave like a PostgREST request from `uid` (or anon). */
async function actAs(tx: Tx, uid: string | null) {
  if (uid) {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`);
    await tx.execute(sql`set local role authenticated`);
  } else {
    await tx.execute(sql`select set_config('request.jwt.claims', '', true)`);
    await tx.execute(sql`set local role anon`);
  }
}

/** Runs `sql` in a savepoint and asserts Postgres rejected it with the expected message. */
async function expectRejected(tx: Tx, query: ReturnType<typeof sql>, message: RegExp) {
  try {
    await tx.transaction(async (sp) => sp.execute(query));
  } catch (err) {
    const e = err as Error & { cause?: Error };
    expect(e.cause?.message ?? e.message).toMatch(message);
    return;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded");
}

const reset = (tx: Tx) => tx.execute(sql`reset role`);
const rows = <T>(r: unknown) => r as unknown as T[];

describe.skipIf(!process.env.DATABASE_URL)("student_profiles Row Level Security (live DB, rolled back)", () => {
  beforeAll(async () => {
    const [{ n }] = rows<{ n: string }>(await db.execute(sql`select count(*)::text n from information_schema.tables where table_name = 'student_profiles'`)) as [{ n: string }];
    expect(n).toBe("1");
  });

  it("signup trigger creates exactly one profile per auth user, with the display name", async () => {
    await inRolledBackTx(async (tx) => {
      const r = rows<{ id: string; display_name: string }>(
        await tx.execute(sql`select id, display_name from public.student_profiles where id in (${A}, ${B}) order by display_name`),
      );
      expect(r.map((x) => x.display_name)).toEqual(["Alice", "Bob"]);
    });
  });

  it("a signed-in user sees only their own profile", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      const seen = rows<{ id: string }>(await tx.execute(sql`select id from public.student_profiles`));
      expect(seen.map((r) => r.id)).toEqual([A]);
      // Asking for another user's row by id (the "tamper with the ID" attack) returns nothing.
      const other = rows(await tx.execute(sql`select id from public.student_profiles where id = ${B}`));
      expect(other).toHaveLength(0);
    });
  });

  it("a user can update their own display name but not someone else's", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      const own = rows(await tx.execute(sql`update public.student_profiles set display_name = 'Alice 2' where id = ${A} returning id`));
      expect(own).toHaveLength(1);
      const theirs = rows(await tx.execute(sql`update public.student_profiles set display_name = 'Hacked' where id = ${B} returning id`));
      expect(theirs).toHaveLength(0);
      await reset(tx);
      const bob = rows<{ display_name: string }>(await tx.execute(sql`select display_name from public.student_profiles where id = ${B}`));
      expect(bob[0]?.display_name).toBe("Bob");
    });
  });

  it("a user cannot hand their row to someone else or edit protected columns", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`update public.student_profiles set id = ${B} where id = ${A}`, /permission denied|row-level security/i);
    });
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`update public.student_profiles set created_at = now() where id = ${A}`, /permission denied/i);
    });
  });

  it("clients cannot insert or delete profiles", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`insert into public.student_profiles (id, display_name) values (gen_random_uuid(), 'x')`, /permission denied/i);
    });
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`delete from public.student_profiles where id = ${A}`, /permission denied/i);
    });
  });

  it("anonymous (not signed in) callers get no access at all", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, null);
      await expectRejected(tx, sql`select * from public.student_profiles`, /permission denied/i);
    });
  });

  it("the signup trigger function cannot be called by API clients", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`select public.handle_new_user()`, /permission denied/i);
    });
  });

  it("leaves no test data behind", async () => {
    const left = rows<{ n: string }>(await db.execute(sql`select count(*)::text n from auth.users where id in (${A}, ${B})`));
    expect(left[0]?.n).toBe("0");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("withUser() helper (used by the API routes)", () => {
  it("runs queries as role `authenticated` with auth.uid() set, and reverts afterwards", async () => {
    const { withUser } = await import("./with-user.js");
    const inside = await withUser(db as never, A, async (tx) =>
      rows<{ who: string; uid: string }>(await tx.execute(sql`select current_user::text as who, auth.uid()::text as uid`)),
    );
    expect(inside[0]).toEqual({ who: "authenticated", uid: A });

    // Same pooled connection (max: 1) afterwards: identity must not leak out of the transaction.
    const after = rows<{ who: string; uid: string | null }>(await db.execute(sql`select current_user::text as who, auth.uid()::text as uid`));
    expect(after[0]?.who).not.toBe("authenticated");
    expect(after[0]?.uid ?? null).toBeNull();
  });
});
