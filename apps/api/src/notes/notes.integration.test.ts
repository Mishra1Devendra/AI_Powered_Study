import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { noteListQuerySchema } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { createTutorRepository } from "../tutor/repository.js";
import { chunkPages } from "./chunker.js";
import { createNotesRepository } from "./repository.js";
import { createNotesService } from "./service.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createFakeStorage } from "./testing/memory.js";

/**
 * Live-database tests for AI Notes. Everything runs inside ONE transaction that is ALWAYS rolled
 * back: no users, documents, chunks, conversations, messages or storage rows are ever persisted,
 * and no real account is touched. Two synthetic users are inserted into auth.users inside it.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DA = "d0000000-0000-4000-8000-00000000000a";
const DB = "d0000000-0000-4000-8000-00000000000b";
const hash = (c: string) => c.repeat(64);
const ROLLBACK = new Error("rollback");

const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rows = <T>(r: unknown) => r as unknown as T[];

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'notes-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'notes-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
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

const RLS = /row-level security|permission denied/i;

/** Server-side (privileged) insert, as the API does after resolving the student from their token. */
async function serverInsertDoc(tx: Tx, userId: string, id: string, h: string, extra: { status?: string; type?: string; path?: string } = {}) {
  await tx.execute(sql`reset role`);
  const type = extra.type ?? "md";
  await tx.execute(sql`
    insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status)
    values (${id}, ${userId}, 'Biology notes', 'bio.md', ${type}, 'upload', 'text/markdown', 100, ${h}, ${extra.path ?? `${userId}/${id}/original.${type}`}, ${extra.status ?? "ready"})`);
}
async function serverInsertChunk(tx: Tx, docId: string, userId: string, index: number, content: string, meta: object = {}) {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`
    insert into public.document_chunks (document_id, user_id, chunk_index, content, char_count, metadata)
    values (${docId}, ${userId}, ${index}, ${content}, ${content.length}, ${JSON.stringify(meta)}::jsonb)`);
}

const live = !!process.env.DATABASE_URL;

describe.skipIf(!live)("documents / document_chunks: privileges and Row Level Security (live DB, rolled back)", () => {
  it("RLS is on and students have only the intended privileges", async () => {
    const info = rows<{ rel: string; rls: boolean }>(
      await db.execute(sql`select relname as rel, relrowsecurity as rls from pg_class where oid in ('public.documents'::regclass, 'public.document_chunks'::regclass)`),
    );
    expect(info.every((r) => r.rls)).toBe(true);
    const tbl = rows<{ t: string; p: string; g: string }>(
      await db.execute(sql`select table_name t, privilege_type p, grantee g from information_schema.role_table_grants where table_schema='public' and table_name in ('documents','document_chunks') and grantee in ('anon','authenticated')`),
    );
    expect(tbl.map((x) => `${x.g}:${x.t}:${x.p}`).sort()).toEqual(["authenticated:document_chunks:SELECT", "authenticated:documents:SELECT"]);
    const cols = rows<{ t: string; c: string; p: string }>(
      await db.execute(sql`select table_name t, column_name c, privilege_type p from information_schema.column_privileges where table_schema='public' and table_name in ('documents','document_chunks') and grantee='authenticated' and privilege_type in ('INSERT','UPDATE')`),
    );
    expect(cols.filter((c) => c.p === "INSERT")).toEqual([]); // students cannot insert documents or chunks
    expect(cols.filter((c) => c.t === "documents" && c.p === "UPDATE").map((c) => c.c).sort()).toEqual(["deleted_at", "last_activity_at", "title"]);
    expect(cols.filter((c) => c.t === "document_chunks")).toEqual([]);
  });

  it("a student sees only their own documents and chunks", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await serverInsertDoc(tx, B, DB, hash("b"));
      await serverInsertChunk(tx, DA, A, 0, "Photosynthesis notes of Alice");
      await serverInsertChunk(tx, DB, B, 0, "Secret mitosis plan of Bob");

      await actAs(tx, A);
      expect(rows<{ id: string }>(await tx.execute(sql`select id from public.documents`)).map((r) => r.id)).toEqual([DA]);
      expect(rows<{ content: string }>(await tx.execute(sql`select content from public.document_chunks`)).map((r) => r.content)).toEqual(["Photosynthesis notes of Alice"]);
      // Guessing / altering the id returns nothing.
      expect(rows(await tx.execute(sql`select 1 from public.documents where id = ${DB}`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`select 1 from public.document_chunks where document_id = ${DB}`))).toHaveLength(0);
      // Full-text search cannot reach Bob's text either.
      expect(rows(await tx.execute(sql`select 1 from public.document_chunks where search_tsv @@ to_tsquery('english', 'mitosis')`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`select 1 from public.document_chunks where search_tsv @@ to_tsquery('english', 'photosynthesis')`))).toHaveLength(1);
    });
  });

  it("students cannot create or alter documents/chunks directly, nor touch the processing lifecycle", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await serverInsertChunk(tx, DA, A, 0, "text");
      await actAs(tx, A);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (gen_random_uuid(), ${A}, 'x','x.md','md','text/markdown',1,${hash("c")},'x')`, /permission denied/i);
      await expectRejected(tx, sql`insert into public.document_chunks (document_id, user_id, chunk_index, content, char_count) values (${DA}, ${A}, 5, 'forged', 6)`, /permission denied/i);
      await expectRejected(tx, sql`update public.documents set processing_status = 'ready' where id = ${DA}`, /permission denied/i);
      await expectRejected(tx, sql`update public.documents set storage_path = 'elsewhere' where id = ${DA}`, /permission denied/i);
      await expectRejected(tx, sql`update public.documents set user_id = ${B} where id = ${DA}`, /permission denied/i);
      await expectRejected(tx, sql`update public.document_chunks set content = 'edited' where document_id = ${DA}`, /permission denied/i);
      await expectRejected(tx, sql`delete from public.documents where id = ${DA}`, /permission denied/i);
      await expectRejected(tx, sql`delete from public.document_chunks where document_id = ${DA}`, /permission denied/i);
    });
  });

  it("a student can rename and soft-delete their own document but never someone else's", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await serverInsertDoc(tx, B, DB, hash("b"));
      await actAs(tx, A);
      expect(rows(await tx.execute(sql`update public.documents set title = 'Renamed' where id = ${DA} returning id`))).toHaveLength(1);
      expect(rows(await tx.execute(sql`update public.documents set title = 'Hacked' where id = ${DB} returning id`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`update public.documents set deleted_at = now() where id = ${DB} returning id`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`update public.documents set deleted_at = now() where id = ${DA} returning id`))).toHaveLength(1);
      await actAs(tx, B);
      expect(rows<{ title: string; deleted_at: unknown }>(await tx.execute(sql`select title, deleted_at from public.documents where id = ${DB}`))[0]).toMatchObject({ title: "Biology notes", deleted_at: null });
    });
  });

  it("anonymous callers get nothing", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await actAs(tx, null);
      await expectRejected(tx, sql`select * from public.documents`, /permission denied/i);
      await expectRejected(tx, sql`select * from public.document_chunks`, /permission denied/i);
    });
  });

  it("database constraints reject malformed or hostile rows even from the server", async () => {
    await inRolledBackTx(async (tx) => {
      const other = "d0000000-0000-4000-8000-0000000000c1";
      // storage_path must be exactly <user>/<document>/original.<ext>: one student can never point at another's folder.
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${other}, ${A}, 't','t.md','md','text/markdown',1,${hash("e")}, ${`${B}/${other}/original.md`})`, /documents_storage_path_owner/);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${other}, ${A}, 't','t.md','md','text/markdown',1,${hash("e")}, '../../etc/passwd')`, /documents_storage_path_owner/);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${other}, ${A}, 't','t.exe','exe','x',1,${hash("e")}, ${`${A}/${other}/original.exe`})`, /documents_file_type_valid/);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${other}, ${A}, 't','t.md','md','text/markdown',1,'not-a-hash', ${`${A}/${other}/original.md`})`, /documents_hash_valid/);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${other}, ${A}, 't','t.md','md','text/markdown',99999999999,${hash("e")}, ${`${A}/${other}/original.md`})`, /documents_size_valid/);
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path, processing_status) values (${other}, ${A}, 't','t.md','md','text/markdown',1,${hash("e")}, ${`${A}/${other}/original.md`}, 'done')`, /documents_status_valid/);
    });
  });

  it("a chunk can only belong to a document of the SAME student (composite foreign key)", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await tx.execute(sql`reset role`);
      await expectRejected(tx, sql`insert into public.document_chunks (document_id, user_id, chunk_index, content, char_count) values (${DA}, ${B}, 0, 'planted in Alice''s document by Bob', 10)`, /foreign key/i);
      await serverInsertChunk(tx, DA, A, 0, "first");
      await expectRejected(tx, sql`insert into public.document_chunks (document_id, user_id, chunk_index, content, char_count) values (${DA}, ${A}, 0, 'dup index', 3)`, /duplicate key|unique/i);
    });
  });

  it("duplicate content is refused per student, but allowed again after the first is hidden or for another student", async () => {
    await inRolledBackTx(async (tx) => {
      const d2 = "d0000000-0000-4000-8000-0000000000d2";
      const d3 = "d0000000-0000-4000-8000-0000000000d3";
      await serverInsertDoc(tx, A, DA, hash("a"));
      await expectRejected(tx, sql`insert into public.documents (id, user_id, title, original_filename, file_type, mime_type, file_size, content_hash, storage_path) values (${d2}, ${A}, 'again','a.md','md','text/markdown',1,${hash("a")}, ${`${A}/${d2}/original.md`})`, /documents_user_hash_active_key/);
      await serverInsertDoc(tx, B, d3, hash("a")); // same bytes, other student: fine
      await tx.execute(sql`update public.documents set deleted_at = now() where id = ${DA}`);
      await serverInsertDoc(tx, A, d2, hash("a")); // first one hidden: allowed
    });
  });
});

describe.skipIf(!live)("notes conversations and messages: new columns (live DB, rolled back)", () => {
  async function seedNotesConversation(tx: Tx, userId: string, docId: string) {
    await actAs(tx, userId);
    const [c] = rows<{ id: string }>(await tx.execute(sql`insert into public.conversations (user_id, title, document_id) values (${userId}, 'Notes: x', ${docId}) returning id`));
    return c!.id;
  }

  it("a notes conversation must reference the student's OWN document, and there is one per document", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      await serverInsertDoc(tx, B, DB, hash("b"));
      await actAs(tx, A);
      await expectRejected(tx, sql`insert into public.conversations (user_id, title, document_id) values (${A}, 'steal', ${DB})`, /foreign key/i);
      await seedNotesConversation(tx, A, DA);
      await expectRejected(tx, sql`insert into public.conversations (user_id, title, document_id) values (${A}, 'second', ${DA})`, /conversations_document_active_key|unique/i);
      // ...and a student cannot attach a conversation to Bob's document even when claiming to be Bob.
      await expectRejected(tx, sql`insert into public.conversations (user_id, title, document_id) values (${B}, 'impersonate', ${DB})`, RLS);
    });
  });

  it("students can request a study action on their own messages but cannot write server-only metadata or invalid actions", async () => {
    await inRolledBackTx(async (tx) => {
      await serverInsertDoc(tx, A, DA, hash("a"));
      const conv = await seedNotesConversation(tx, A, DA);
      await actAs(tx, A);
      const [m] = rows<{ action: string }>(await tx.execute(sql`insert into public.messages (conversation_id, user_id, role, content, action) values (${conv}, ${A}, 'user', 'Summarize', 'summarize') returning action`));
      expect(m?.action).toBe("summarize");
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content, action) values (${conv}, ${A}, 'user', 'x', 'delete_everything')`, /messages_action_valid/);
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content, metadata) values (${conv}, ${A}, 'user', 'x', '{"sources":[]}'::jsonb)`, /permission denied/i);
      // Bob cannot read or write Alice's notes chat.
      await actAs(tx, B);
      expect(rows(await tx.execute(sql`select 1 from public.messages where conversation_id = ${conv}`))).toHaveLength(0);
      await expectRejected(tx, sql`insert into public.messages (conversation_id, user_id, role, content) values (${conv}, ${B}, 'user', 'hi')`, /foreign key|row-level security/i);
    });
  });
});

describe.skipIf(!live)("private storage bucket and its policies (live DB, rolled back)", () => {
  it("the notes bucket exists, is private, and is size/type limited", async () => {
    const [b] = rows<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      await db.execute(sql`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'notes'`),
    );
    expect(b?.public).toBe(false);
    expect(Number(b?.file_size_limit)).toBe(10 * 1024 * 1024);
    expect([...(b?.allowed_mime_types ?? [])].sort()).toEqual(["application/pdf", "text/markdown", "text/plain"]);
  });

  it("a student can add and read objects only inside their own folder; others see nothing; nothing can be changed or removed", async () => {
    await inRolledBackTx(async (tx) => {
      await actAs(tx, A);
      await tx.execute(sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', ${`${A}/${DA}/original.md`}, ${A})`);
      expect(rows(await tx.execute(sql`select 1 from storage.objects where bucket_id = 'notes'`))).toHaveLength(1);
      // Into Bob's folder, or another bucket: refused.
      await expectRejected(tx, sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', ${`${B}/${DB}/original.md`}, ${A})`, RLS);
      await expectRejected(tx, sql`insert into storage.objects (bucket_id, name, owner_id) values ('notes', 'loose-file.md', ${A})`, RLS);
      await expectRejected(tx, sql`insert into storage.objects (bucket_id, name, owner_id) values ('some-public-bucket', ${`${A}/x/original.md`}, ${A})`, RLS);
      // No update / delete policy: those statements affect nothing.
      expect(rows(await tx.execute(sql`update storage.objects set name = ${`${A}/${DA}/renamed.md`} where bucket_id = 'notes' returning id`))).toHaveLength(0);
      // Supabase additionally blocks direct DELETEs on storage.objects with a trigger.
      await expectRejected(tx, sql`delete from storage.objects where bucket_id = 'notes'`, /Direct deletion|permission denied|not allowed/i);

      await actAs(tx, B);
      expect(rows(await tx.execute(sql`select 1 from storage.objects where bucket_id = 'notes'`))).toHaveLength(0); // cannot even see Alice's file
      await actAs(tx, null);
      expect(rows(await tx.execute(sql`select 1 from storage.objects where bucket_id = 'notes'`))).toHaveLength(0);
    });
  });
});

describe.skipIf(!live)("notes repository against the live database (rolled back)", () => {
  const sample = `# Biology\n\n## Photosynthesis\n\n${"Chlorophyll in the chloroplast absorbs light and drives photosynthesis in plant cells. ".repeat(8)}\n\n## Mitosis\n\n${"Mitosis divides one cell into two identical daughter cells in four phases. ".repeat(8)}`;
  const mkDoc = (id: string, userId: string, h: string) => ({
    id,
    userId,
    title: "Biology notes",
    originalFilename: "bio.md",
    fileType: "md" as const,
    source: "upload" as const,
    mimeType: "text/markdown",
    fileSize: sample.length,
    contentHash: h,
    storagePath: `${userId}/${id}/original.md`,
  });

  it("stores, reads, searches and isolates documents with real SQL, RLS and full-text search", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = createNotesRepository(tx as unknown as Database);
      const chunks = chunkPages([{ page: null, text: sample }]);
      expect(chunks.length).toBeGreaterThan(1);

      const created = await repo.createDocument(mkDoc(DA, A, hash("a")));
      expect(created).toMatchObject({ status: "uploading", chunkCount: 0, title: "Biology notes" });
      await repo.setStatus(A, DA, { status: "processing" });
      expect((await repo.getNote(A, DA))?.status).toBe("processing");
      await repo.saveChunksAndMarkReady(A, DA, chunks, { pageCount: null, charCount: sample.length, sourceFilename: "bio.md" });

      const ready = (await repo.getNote(A, DA))!;
      expect(ready).toMatchObject({ status: "ready", error: null, chunkCount: chunks.length });

      // Content paging, outline and ordering
      const page1 = await repo.getContentPage(A, DA, 0, 1);
      expect(page1).toHaveLength(1);
      expect(page1[0]).toMatchObject({ index: 0, page: null });
      expect((await repo.getContentPage(A, DA, 1, 50)).map((c) => c.index)).toEqual(chunks.slice(1).map((c) => c.index));
      expect((await repo.getOutline(A, DA)).map((o) => o.heading)).toEqual(expect.arrayContaining(["Photosynthesis", "Mitosis"]));

      // Real Postgres full-text retrieval
      const hits = await repo.searchChunks(A, DA, ["chlorophyll", "photosynthesis"], 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.content).toContain("Chlorophyll");
      expect(await repo.searchChunks(A, DA, ["zeppelin"], 5)).toEqual([]);
      expect(await repo.searchChunks(A, DA, ["'; drop table documents; --", "a&b|c!d"], 5)).toEqual([]); // hostile input is inert
      expect((await repo.getChunks(A, DA, [0, 1])).map((c) => c.chunkIndex)).toEqual([0, 1]);

      // List / search / filter
      expect((await repo.listNotes(A, noteListQuerySchema.parse({ q: "bio" }))).map((n) => n.id)).toEqual([DA]);
      expect(await repo.listNotes(A, noteListQuerySchema.parse({ q: "100%_" }))).toEqual([]); // wildcards are literal
      expect(await repo.listNotes(A, noteListQuerySchema.parse({ type: "pdf" }))).toEqual([]);
      expect((await repo.listNotes(A, noteListQuerySchema.parse({ status: "ready", sort: "name" }))).length).toBe(1);

      // Duplicate detection and the unique-violation shape the service relies on
      expect((await repo.findActiveByHash(A, hash("a")))?.id).toBe(DA);
      expect(await repo.findActiveByHash(B, hash("a"))).toBeNull();
      // (own savepoint, so the expected failure does not abort the surrounding test transaction)
      const err = await tx.transaction((sp) => createNotesRepository(sp as unknown as Database).createDocument(mkDoc("d0000000-0000-4000-8000-0000000000e1", A, hash("a")))).catch((e) => e);
      expect((err as { code?: string }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505").toBe(true);

      // Student B sees and can do nothing with Alice's document
      expect(await repo.getNote(B, DA)).toBeNull();
      expect(await repo.getStorageInfo(B, DA)).toBeNull();
      expect(await repo.listNotes(B, noteListQuerySchema.parse({}))).toEqual([]);
      expect(await repo.getContentPage(B, DA, 0, 50)).toEqual([]);
      expect(await repo.getOutline(B, DA)).toEqual([]);
      expect(await repo.searchChunks(B, DA, ["chlorophyll"], 5)).toEqual([]);
      expect(await repo.getChunks(B, DA, [0, 1])).toEqual([]);
      expect(await repo.softDelete(B, DA)).toBe(false);
      expect(await repo.findConversation(B, DA)).toBeNull();
      await expect(repo.getOrCreateConversation(B, DA, "steal")).rejects.toBeDefined();

      // Per-document conversation: created once, reused
      const c1 = await repo.getOrCreateConversation(A, DA, "Notes: Biology");
      const c2 = await repo.getOrCreateConversation(A, DA, "Notes: Biology");
      expect(c2.id).toBe(c1.id);
      expect((await repo.findConversation(A, DA))?.id).toBe(c1.id);

      // The tutor cannot see the notes conversation (kept separate)
      const tutor = createTutorRepository(tx as unknown as Database);
      expect(await tutor.getConversation(A, c1.id)).toBeNull();
      expect(await tutor.listConversations(A, 50)).toEqual([]);
      expect(await tutor.archiveConversation(A, c1.id)).toBe(false);

      // Messages through the shared message methods, with sources written by the server
      const q = await tutor.addUserMessage(A, c1.id, { content: "Summarize", action: "summarize" });
      expect(q).toMatchObject({ role: "user", action: "summarize" });
      const a = await tutor.addAssistantMessage(A, c1.id, { content: "Summary [S1]", model: "mock-demo", isMock: true, sources: [{ key: "S1", chunkIndex: 0, page: null, heading: "Photosynthesis" }] });
      expect(a.sources).toEqual([{ key: "S1", chunkIndex: 0, page: null, heading: "Photosynthesis" }]);
      const history = await tutor.listMessages(A, c1.id, 10);
      expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(history[1]!.sources?.[0]?.heading).toBe("Photosynthesis");
      expect(await tutor.listMessages(B, c1.id, 10)).toEqual([]);

      // Activity + soft delete retains everything
      await repo.touchActivity(A, DA);
      expect(await repo.softDelete(A, DA)).toBe(true);
      expect(await repo.getNote(A, DA)).toBeNull();
      expect(await repo.listNotes(A, noteListQuerySchema.parse({}))).toEqual([]);
      expect(await repo.softDelete(A, DA)).toBe(false);
      const kept = rows<{ docs: number; chunks: number; messages: number }>(
        await tx.execute(sql`select (select count(*) from public.documents where id = ${DA})::int docs, (select count(*) from public.document_chunks where document_id = ${DA})::int chunks, (select count(*) from public.messages where conversation_id = ${c1.id})::int messages`),
      );
      expect(kept[0]).toEqual({ docs: 1, chunks: chunks.length, messages: 2 }); // nothing was destroyed
    });
  });

  it("chunks are saved all-or-nothing: a failure part-way leaves no chunks and the document not ready", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = createNotesRepository(tx as unknown as Database);
      await repo.createDocument(mkDoc(DA, A, hash("a")));
      const good = chunkPages([{ page: null, text: sample }]);
      const bad = [...good, { ...good[0]!, index: 0 }]; // duplicate index at the end -> unique violation
      await expect(repo.saveChunksAndMarkReady(A, DA, bad, { pageCount: null, charCount: 1, sourceFilename: "bio.md" })).rejects.toBeDefined();
      const left = rows<{ n: number; status: string }>(await tx.execute(sql`select (select count(*) from public.document_chunks where document_id = ${DA})::int n, (select processing_status from public.documents where id = ${DA}) status`));
      expect(left[0]).toEqual({ n: 0, status: "uploading" });
    });
  });
});

describe.skipIf(!live)("AI Notes end to end on the live database (rolled back, mock AI, fake storage)", () => {
  it("upload -> process -> read -> ask -> isolate -> soft delete, with real SQL and RLS", async () => {
    await inRolledBackTx(async (tx) => {
      const database = tx as unknown as Database;
      const tutorRepo = createTutorRepository(database);
      const fake = createFakeStorage();
      const service = createNotesService({ repo: createNotesRepository(database), tutorRepo, storage: fake.storage, ai: new MockProvider(0) });
      const text = `# Cells\n\n## Mitochondria\n\n${"Mitochondria produce ATP through cellular respiration inside the cell. ".repeat(10)}\n\n## Ribosomes\n\n${"Ribosomes build proteins by translating messenger RNA in the cytoplasm. ".repeat(10)}`;

      const note = await service.uploadFile(A, `token:${A}`, { filename: "../cells.md", bytes: new TextEncoder().encode(text) });
      expect(note).toMatchObject({ status: "ready", originalFilename: "cells.md", fileType: "md" });
      expect([...fake.objects.keys()]).toEqual([`${A}/${note.id}/original.md`]);
      await expect(service.uploadFile(A, `token:${A}`, { filename: "again.md", bytes: new TextEncoder().encode(text) })).rejects.toMatchObject({ code: "duplicate_note" });

      const content = await service.content(A, note.id, 0, 50);
      expect(content.chunks.length).toBe(note.chunkCount);

      const events: string[] = [];
      let sources: unknown;
      const turn = await service.startAssistant(A, note.id, { action: "ask", question: "How do ribosomes make proteins?" });
      for await (const e of turn.events(new AbortController().signal)) {
        events.push(e.type);
        if (e.type === "done") sources = e.message.sources;
      }
      turn.release();
      expect(events[0]).toBe("user_message");
      expect(events.at(-1)).toBe("done");
      expect(JSON.stringify(sources)).toContain("Ribosomes"); // real full-text retrieval found the right section

      const convo = await service.conversation(A, note.id);
      expect(convo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

      // Student B: nothing of Alice's is reachable through the real service + RLS
      for (const attempt of [
        () => service.detail(B, note.id),
        () => service.content(B, note.id, 0, 10),
        () => service.conversation(B, note.id),
        () => service.startAssistant(B, note.id, { action: "summarize" }),
        () => service.retry(B, `token:${B}`, note.id),
        () => service.remove(B, note.id),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ status: 404 });
      }
      expect(await service.list(B, noteListQuerySchema.parse({}))).toEqual([]);

      await service.remove(A, note.id);
      expect(await service.list(A, noteListQuerySchema.parse({}))).toEqual([]);
      const kept = rows<{ n: number }>(await tx.execute(sql`select (select count(*) from public.document_chunks where document_id = ${note.id})::int n`));
      expect(kept[0]?.n).toBe(note.chunkCount); // soft delete: text retained
    });
  });
});

describe.skipIf(!live)("cleanup", () => {
  it("leaves no test data behind", async () => {
    const left = rows<{ n: string }>(
      await db.execute(sql`select (select count(*) from auth.users where id in (${A}, ${B})) + (select count(*) from public.documents where user_id in (${A}, ${B})) + (select count(*) from public.document_chunks where user_id in (${A}, ${B})) + (select count(*) from storage.objects where bucket_id = 'notes' and name like ${`${A}/%`}) as n`),
    );
    expect(Number(left[0]?.n)).toBe(0);
  });
});
