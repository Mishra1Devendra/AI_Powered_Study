import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { createTutorRepository } from "./repository.js";

/**
 * Live-database tests for conversations/messages. Everything runs inside ONE transaction that is
 * always rolled back: no users, conversations or messages are ever persisted, and no real
 * account is touched. Two synthetic rows are inserted into auth.users inside that transaction.
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
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tutor-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tutor-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      await fn(tx);
      throw ROLLBACK;
    }),
  ).rejects.toBe(ROLLBACK);
}

async function actAs(tx: Tx, uid: string | null) {
  await tx.execute(sql`reset role`);
  if (uid) {
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`);
    await tx.execute(sql`set local role authenticated`);
  } else {
    await tx.execute(sql`select set_config('request.jwt.claims', '', true)`);
    await tx.execute(sql`set local role anon`);
  }
}

/** Runs a statement in a savepoint and asserts Postgres rejected it with the expected message. */
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

const rows = <T>(r: unknown) => r as unknown as T[];
const RLS = /row-level security|permission denied/i;

/** Creates one conversation per user (as that user) and returns their ids. */
async function seed(tx: Tx) {
  await actAs(tx, A);
  const [a] = rows<{ id: string }>(await tx.execute(sql`insert into public.conversations (user_id, title) values (${A}, 'A convo') returning id`));
  await tx.execute(sql`insert into public.messages (conversation_id, user_id, role, content) values (${a!.id}, ${A}, 'user', 'A secret question')`);
  await actAs(tx, B);
  const [b] = rows<{ id: string }>(await tx.execute(sql`insert into public.conversations (user_id, title) values (${B}, 'B convo') returning id`));
  await tx.execute(sql`insert into public.messages (conversation_id, user_id, role, content) values (${b!.id}, ${B}, 'user', 'B secret question')`);
  await tx.execute(sql`reset role`);
  return { a: a!.id, b: b!.id };
}

describe.skipIf(!process.env.DATABASE_URL)("conversations/messages Row Level Security (live DB, rolled back)", () => {
  it("RLS is enabled and clients have only the intended privileges", async () => {
    const info = rows<{ rel: string; rls: boolean }>(
      await db.execute(sql`select relname as rel, relrowsecurity as rls from pg_class where oid in ('public.conversations'::regclass, 'public.messages'::regclass)`),
    );
    expect(info.every((r) => r.rls)).toBe(true);
    const grants = rows<{ t: string; p: string }>(
      await db.execute(sql`select table_name t, privilege_type p from information_schema.role_table_grants where table_schema = 'public' and table_name in ('conversations','messages') and grantee in ('anon','authenticated')`),
    );
    expect(grants.map((g) => `${g.t}:${g.p}`).sort()).toEqual(["conversations:SELECT", "messages:SELECT"]); // + column-level INSERT/UPDATE below
    const cols = rows<{ t: string; c: string; p: string }>(
      await db.execute(sql`select table_name t, column_name c, privilege_type p from information_schema.column_privileges where table_schema='public' and table_name in ('conversations','messages') and grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE')`),
    );
    expect(cols.filter((c) => c.t === "messages").map((c) => c.p)).not.toContain("UPDATE");
    expect(cols.filter((c) => c.p === "UPDATE" && c.t === "conversations").map((c) => c.c).sort()).toEqual(["deleted_at", "level", "subject", "title", "topic"]);
    expect(cols.filter((c) => c.p === "INSERT" && c.t === "messages").map((c) => c.c).sort()).toEqual(["action", "content", "conversation_id", "mode", "role", "user_id"]); // "action" was added for AI Notes
  });

  it("a student sees only their own conversations and messages", async () => {
    await inRolledBackTx(async (tx) => {
      const { a, b } = await seed(tx);
      await actAs(tx, A);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.conversations`)).map((r) => r.id)).toEqual([a]);
      expect(rows(await tx.execute(sql`select id from public.conversations where id = ${b}`))).toHaveLength(0);
      expect(rows<{ content: string }>(await tx.execute(sql`select content from public.messages`)).map((r) => r.content)).toEqual(["A secret question"]);
      expect(rows(await tx.execute(sql`select 1 from public.messages where conversation_id = ${b}`))).toHaveLength(0);
    });
  });

  it("a student cannot create a conversation owned by someone else", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await expectRejected(tx, sql`insert into public.conversations (user_id, title) values (${B}, 'forged')`, RLS);
    });
  });

  it("a student cannot modify another student's conversation, nor change ownership or timestamps", async () => {
    await inRolledBackTx(async (tx) => {
      const { a, b } = await seed(tx);
      await actAs(tx, A);
      expect(rows(await tx.execute(sql`update public.conversations set title = 'hacked' where id = ${b} returning id`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`update public.conversations set title = 'mine', topic = 'x' where id = ${a} returning id`))).toHaveLength(1);
      expect(rows(await tx.execute(sql`update public.conversations set deleted_at = now() where id = ${a} returning id`))).toHaveLength(1); // soft delete is allowed
      await expectRejected(tx, sql`update public.conversations set user_id = ${B} where id = ${a}`, RLS);
      await expectRejected(tx, sql`update public.conversations set created_at = now() where id = ${a}`, /permission denied/i);
      await actAs(tx, B);
      expect(rows<{ title: string }>(await tx.execute(sql`select title from public.conversations where id = ${b}`))[0]?.title).toBe("B convo");
    });
  });

  it("clients can never hard-delete conversations or messages", async () => {
    await inRolledBackTx(async (tx) => {
      const { a } = await seed(tx);
      await actAs(tx, A);
      await expectRejected(tx, sql`delete from public.conversations where id = ${a}`, /permission denied/i);
      await expectRejected(tx, sql`delete from public.messages where conversation_id = ${a}`, /permission denied/i);
    });
  });

  it("messages are append-only for clients and a student cannot write into another student's conversation", async () => {
    await inRolledBackTx(async (tx) => {
      const { a, b } = await seed(tx);
      await actAs(tx, A);
      await expectRejected(tx, sql`update public.messages set content = 'edited' where conversation_id = ${a}`, /permission denied/i);
      // into B's conversation, claiming to be A / claiming to be B
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${b}, ${A}, 'user', 'injected')`, /foreign key|violates|row-level security/i);
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${b}, ${B}, 'user', 'impersonated')`, RLS);
      // forging what the tutor said, even in their own conversation
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${a}, ${A}, 'assistant', 'forged tutor reply')`, RLS);
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content, is_mock) values (${a}, ${A}, 'user', 'x', true)`, /permission denied/i);
      // oversized / invalid values are rejected by constraints
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content, mode) values (${a}, ${A}, 'user', 'x', 'cheat')`, /check constraint/i);
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${a}, ${A}, 'user', '')`, /check constraint/i);
      await expectRejected(tx, sql`update public.conversations set level = 'expert' where id = ${a}`, /check constraint/i);
    });
  });

  it("the composite foreign key makes a message's owner always equal its conversation's owner", async () => {
    await inRolledBackTx(async (tx) => {
      const { a } = await seed(tx);
      await tx.execute(sql`reset role`); // privileged server connection
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${a}, ${B}, 'assistant', 'mismatched owner')`, /foreign key/i);
    });
  });

  it("anonymous callers get no access to either table", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await actAs(tx, null);
      await expectRejected(tx, sql`select * from public.conversations`, /permission denied/i);
      await expectRejected(tx, sql`select * from public.messages`, /permission denied/i);
      await expectRejected(tx, sql`insert into public.conversations (user_id) values (${A})`, /permission denied/i);
    });
  });

  it("trigger functions exist and are not callable by API clients", async () => {
    await inRolledBackTx(async (tx) => {
      const t = rows<{ tgname: string }>(
        await tx.execute(sql`select tgname from pg_trigger where not tgisinternal and tgname in ('messages_touch_conversation','conversations_set_updated_at')`),
      );
      expect(t.map((x) => x.tgname).sort()).toEqual(["conversations_set_updated_at", "messages_touch_conversation"]);
      await actAs(tx, A);
      await expectRejected(tx, sql`select public.touch_conversation_on_message()`, /permission denied/i);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("tutor repository against the live database (rolled back)", () => {
  it("round-trips conversations and messages through real RLS, and isolates two students", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = createTutorRepository(tx as unknown as Database);

      expect(await repo.getStudentName(A)).toBe("Alice"); // profile created by the signup trigger

      const conv = await repo.createConversation(A, { subject: "Physics", topic: "Thermodynamics", level: "advanced" });
      expect(conv).toMatchObject({ title: "New conversation", subject: "Physics", topic: "Thermodynamics", level: "advanced" });
      const other = await repo.createConversation(B, {});

      // listing and loading are scoped to the owner
      expect((await repo.listConversations(A, 10)).map((c) => c.id)).toEqual([conv.id]);
      expect((await repo.listConversations(B, 10)).map((c) => c.id)).toEqual([other.id]);
      expect(await repo.getConversation(A, conv.id)).toMatchObject({ id: conv.id });
      expect(await repo.getConversation(B, conv.id)).toBeNull();

      // messages: student message then server-written assistant message
      const u = await repo.addUserMessage(A, conv.id, { content: "What is entropy?", mode: "explain_simply" });
      const m = await repo.addAssistantMessage(A, conv.id, { content: "A measure of disorder.", model: "claude-opus-5-5", isMock: false });
      expect(u).toMatchObject({ role: "user", mode: "explain_simply", isMock: false });
      expect(m).toMatchObject({ role: "assistant", model: "claude-opus-5-5", isMock: false });
      expect((await repo.listMessages(A, conv.id, 50)).map((x) => x.role)).toEqual(["user", "assistant"]);

      // student B can neither read nor write into A's conversation through the repository
      expect(await repo.listMessages(B, conv.id, 50)).toEqual([]);
      await expect(repo.addUserMessage(B, conv.id, { content: "injected", mode: null })).rejects.toBeDefined();
      expect(await repo.updateConversation(B, conv.id, { title: "hacked" })).toBeNull();
      expect(await repo.archiveConversation(B, conv.id)).toBe(false);
      expect((await repo.listMessages(A, conv.id, 50)).map((x) => x.content)).toEqual(["What is entropy?", "A measure of disorder."]);

      // update and soft delete by the owner
      expect(await repo.updateConversation(A, conv.id, { title: "Entropy", topic: null })).toMatchObject({ title: "Entropy", topic: null });
      expect(await repo.archiveConversation(A, conv.id)).toBe(true);
      expect(await repo.getConversation(A, conv.id)).toBeNull();
      expect(await repo.listConversations(A, 10)).toEqual([]);
      // ...but the rows are retained (privileged check)
      const kept = rows<{ n: string }>(await tx.execute(sql`select count(*)::text n from public.messages where conversation_id = ${conv.id}`));
      expect(kept[0]?.n).toBe("2");
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("cleanup", () => {
  it("leaves no test data behind", async () => {
    const left = rows<{ n: string }>(await db.execute(sql`select (select count(*) from auth.users where id in (${A}, ${B})) + (select count(*) from public.conversations where user_id in (${A}, ${B})) + (select count(*) from public.messages where user_id in (${A}, ${B})) as n`));
    expect(Number(left[0]?.n)).toBe(0);
  });
});
