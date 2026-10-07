import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { NOT_IN_NOTES_MESSAGE } from "@copilot/shared";
import type { Database } from "../db/client.js";
import { NotFoundError } from "../errors.js";
import { createKnowledgeRepository } from "./repository.js";
import { createKnowledgeService } from "./service.js";

/**
 * Live-database tests for knowledge grounding (Phase 11). Everything runs inside ONE transaction that is ALWAYS rolled
 * back: no users, documents or chunks are ever persisted and no real account is touched. Two synthetic users are
 * inserted into auth.users inside it. These tests run the REAL SQL (full-text search, joins, Row Level Security) that
 * the unit tests can only imitate.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC_A = "e1000000-0000-4000-8000-00000000000a";
const DOC_A2 = "e1000000-0000-4000-8000-0000000000a2";
const DOC_B = "e1000000-0000-4000-8000-00000000000b";
const DOC_FAILED = "e1000000-0000-4000-8000-0000000000f1";
const VIVA_A = "e2000000-0000-4000-8000-00000000000a";
const VIVA_Q = "e3000000-0000-4000-8000-00000000000a";
const ROLLBACK = new Error("rollback");

const live = !!process.env.DATABASE_URL;
const client = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
const db = drizzle(client);
afterAll(() => client.end({ timeout: 5 }));

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rows = <T>(r: unknown) => r as unknown as T[];
const hash = (c: string) => c.repeat(64).slice(0, 64);

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>) {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
        values
          (${A}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'know-a@invalid.test', '{"display_name":"Alice"}'::jsonb, now(), now()),
          (${B}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'know-b@invalid.test', '{"display_name":"Bob"}'::jsonb, now(), now())`);
      try {
        await fn(tx);
      } catch (err) {
        const cause = (err as { cause?: Error }).cause;
        if (cause) (err as Error).message += ` | cause: ${cause.message}`;
        throw err;
      }
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

async function doc(tx: Tx, userId: string, id: string, title: string, h: string, opts: { status?: string; chunkCount?: number; deleted?: boolean } = {}) {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`
    insert into public.documents (id, user_id, title, original_filename, file_type, source, mime_type, file_size, content_hash, storage_path, processing_status, chunk_count, deleted_at)
    values (${id}, ${userId}, ${title}, 'x.md', 'md', 'upload', 'text/markdown', 100, ${hash(h)}, ${`${userId}/${id}/original.md`}, ${opts.status ?? "ready"}, ${opts.chunkCount ?? 0}, ${opts.deleted ? sql`now()` : null})`);
}
async function chunk(tx: Tx, docId: string, userId: string, index: number, content: string, meta: object = {}) {
  await tx.execute(sql`reset role`);
  await tx.execute(sql`
    insert into public.document_chunks (document_id, user_id, chunk_index, content, char_count, metadata)
    values (${docId}, ${userId}, ${index}, ${content}, ${content.length}, ${JSON.stringify(meta)}::jsonb)`);
}

const PHOTO = "Photosynthesis is the process by which plants convert light energy into chemical energy stored in glucose. It takes place in the chloroplasts, which contain chlorophyll.";
const ENTROPY = "Entropy is a measure of the disorder of a system. The second law of thermodynamics says the entropy of an isolated system never decreases.";

async function seed(tx: Tx) {
  await doc(tx, A, DOC_A, "Biology.pdf", "a", { chunkCount: 2 });
  await chunk(tx, DOC_A, A, 0, PHOTO, { page: 14, heading: "Photosynthesis" });
  await chunk(tx, DOC_A, A, 1, "Mitosis produces two genetically identical daughter cells during cell division.", { page: 15, heading: "Cell Division" });
  await doc(tx, A, DOC_A2, "Physics.md", "b", { chunkCount: 1 });
  await chunk(tx, DOC_A2, A, 0, ENTROPY, { heading: "Entropy" });
  await doc(tx, B, DOC_B, "Bob chemistry", "c", { chunkCount: 1 });
  await chunk(tx, DOC_B, B, 0, "Catalysts lower the activation energy of a chemical reaction and are not consumed.", { page: 3 });
  // A's failed and soft-deleted documents still have stored chunks, but must never be searched.
  await doc(tx, A, DOC_FAILED, "Half-done", "d", { status: "failed", chunkCount: 1 });
  await chunk(tx, DOC_FAILED, A, 0, "Photosynthesis chloroplasts leftover text from a failed run.");
}

describe.skipIf(!live)("knowledge retrieval (live DB, rolled back)", () => {
  it("full-text search finds the student's passage with its REAL page and heading", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const knowledge = createKnowledgeService({ repo: createKnowledgeRepository(tx as unknown as Database) });
      const r = await knowledge.retrieveRelevantChunks(A, { query: "Where does photosynthesis happen in the chloroplasts?" });
      expect(r).toMatchObject({ relevant: true, method: "fulltext" });
      expect(r.chunks[0]).toMatchObject({ documentId: DOC_A, documentTitle: "Biology.pdf", chunkIndex: 0, page: 14, heading: "Photosynthesis" });
      expect(r.chunks.map((c) => c.documentId)).not.toContain(DOC_FAILED);
      // A document with no page numbers (Markdown) yields null - never an invented page.
      const phys = await knowledge.retrieveRelevantChunks(A, { query: "second law of thermodynamics entropy" });
      expect(phys.chunks[0]).toMatchObject({ documentId: DOC_A2, page: null, heading: "Entropy" });
    });
  });

  it("an unrelated question retrieves nothing; stemming works (engines / engine, plants / plant)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const knowledge = createKnowledgeService({ repo: createKnowledgeRepository(tx as unknown as Database) });
      expect(await knowledge.retrieveRelevantChunks(A, { query: "Explain quantum chromodynamics and gluons" })).toMatchObject({ relevant: false, chunks: [] });
      expect((await knowledge.retrieveRelevantChunks(A, { query: "how do plants convert light energy" })).relevant).toBe(true);
    });
  });

  it("documentId limits the search; a document of another student is 'not found'", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const knowledge = createKnowledgeService({ repo: createKnowledgeRepository(tx as unknown as Database) });
      const only = await knowledge.retrieveRelevantChunks(A, { query: "entropy photosynthesis cells", documentId: DOC_A2, minCoverage: 0 });
      expect(only.chunks.every((c) => c.documentId === DOC_A2)).toBe(true);
      await expect(knowledge.retrieveRelevantChunks(B, { query: "photosynthesis chloroplasts", documentId: DOC_A })).rejects.toBeInstanceOf(NotFoundError);
      await expect(knowledge.retrieveRelevantChunks(A, { query: "photosynthesis", documentId: DOC_FAILED })).rejects.toMatchObject({ status: 409 });
    });
  });

  it("student B never sees student A's chunks - through search, lookups by reference, or document info", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const repo = createKnowledgeRepository(tx as unknown as Database);
      expect(await repo.search(B, { words: ["photosynthesis", "chloroplasts"], documentIds: null, limit: 10 })).toEqual([]);
      expect(await repo.search(B, { words: ["photosynthesis"], documentIds: [DOC_A], limit: 10 })).toEqual([]);
      expect(await repo.getByRefs(B, [{ documentId: DOC_A, chunkIndex: 0 }])).toEqual([]);
      expect(await repo.documentInfo(B, DOC_A)).toBeNull();
      expect((await repo.readyDocuments(B, 10)).map((d) => d.id)).toEqual([DOC_B]);
      // ...while A sees exactly their own ready documents (not the failed one).
      expect((await repo.readyDocuments(A, 10)).map((d) => d.id).sort()).toEqual([DOC_A, DOC_A2].sort());
      // And B can see their own.
      expect((await repo.search(B, { words: ["catalysts", "activation"], documentIds: null, limit: 10 })).map((r) => r.documentId)).toEqual([DOC_B]);
    });
  });

  it("the database itself refuses cross-student reads (RLS), whatever the application asks", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await actAs(tx, B);
      expect(rows(await tx.execute(sql`select 1 from public.document_chunks where document_id = ${DOC_A}`))).toHaveLength(0);
      expect(rows(await tx.execute(sql`select 1 from public.documents where id = ${DOC_A}`))).toHaveLength(0);
      await actAs(tx, null);
      await expectRejected(tx, sql`select 1 from public.document_chunks`, /permission denied|row-level security/i);
    });
  });

  it("soft-deleted documents are not searchable", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await doc(tx, A, "e1000000-0000-4000-8000-0000000000d1", "Deleted notes", "e", { deleted: true, chunkCount: 1 });
      await chunk(tx, "e1000000-0000-4000-8000-0000000000d1", A, 0, "Quasar redshift spectroscopy observations of distant galaxies.");
      const repo = createKnowledgeRepository(tx as unknown as Database);
      expect(await repo.search(A, { words: ["quasar", "redshift"], documentIds: null, limit: 5 })).toEqual([]);
      expect(await repo.documentInfo(A, "e1000000-0000-4000-8000-0000000000d1")).toBeNull();
    });
  });

  it("search words can never inject query syntax or SQL", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const repo = createKnowledgeRepository(tx as unknown as Database);
      for (const w of ["'; drop table documents; --", "photo:*", "!(a|b)&c", "a & b | c", "\\u0000"]) {
        await expect(repo.search(A, { words: [w, "photosynthesis"], documentIds: null, limit: 5 })).resolves.toBeDefined();
      }
      expect((await repo.readyDocuments(A, 5)).length).toBeGreaterThan(0); // nothing was dropped
    });
  });

  it("topicMatches finds a topic only when ALL its words appear in one passage of the student's own ready document", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      const repo = createKnowledgeRepository(tx as unknown as Database);
      const m = await repo.topicMatches(A, ["Photosynthesis", "second law", "Roman history", "Catalysts"]);
      expect(m.map((x) => x.topic).sort()).toEqual(["Photosynthesis", "second law"]);
      expect(m.find((x) => x.topic === "Photosynthesis")).toMatchObject({ documentId: DOC_A, page: 14, heading: "Photosynthesis" });
      expect((await repo.topicMatches(B, ["Photosynthesis"]))).toEqual([]);
      expect((await repo.topicMatches(B, ["Catalysts"])).map((x) => x.documentId)).toEqual([DOC_B]);
    });
  });

  it("an empty topic list or empty search is answered without a query", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = createKnowledgeRepository(tx as unknown as Database);
      expect(await repo.topicMatches(A, [])).toEqual([]);
      expect(await repo.search(A, { words: [], documentIds: null, limit: 5 })).toEqual([]);
      expect(await repo.search(A, { words: ["x"], documentIds: [], limit: 5 })).toEqual([]);
      expect(await repo.getByRefs(A, [])).toEqual([]);
    });
  });

  it("the constant used for 'not found' is the spec's wording", () => {
    expect(NOT_IN_NOTES_MESSAGE).toBe("I couldn't find this topic in your uploaded material. I can still explain it using general knowledge.");
  });
});

describe.skipIf(!live)("viva source columns (live DB, rolled back)", () => {
  it("existing behaviour is unchanged: a viva defaults to 'general' with no document", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`insert into public.viva_sessions (id, user_id, subject, difficulty, question_count) values (${VIVA_A}, ${A}, 'Chemistry', 'medium', 5)`);
      const [s] = rows<{ source_type: string; document_id: string | null }>(await tx.execute(sql`select source_type, document_id from public.viva_sessions where id = ${VIVA_A}`));
      expect(s).toEqual({ source_type: "general", document_id: null });
    });
  });

  it("a specific-document viva must name a document of the SAME student (composite foreign key + consistency check)", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await tx.execute(sql`insert into public.viva_sessions (id, user_id, subject, difficulty, question_count, source_type, document_id) values (${VIVA_A}, ${A}, 'Biology', 'easy', 3, 'document', ${DOC_A})`);
      await expectRejected(tx, sql`insert into public.viva_sessions (user_id, subject, difficulty, question_count, source_type, document_id) values (${A}, 'Bio', 'easy', 3, 'document', ${DOC_B})`, /foreign key/i);
      await expectRejected(tx, sql`insert into public.viva_sessions (user_id, subject, difficulty, question_count, source_type) values (${A}, 'Bio', 'easy', 3, 'document')`, /viva_sessions_source_consistent/);
      await expectRejected(tx, sql`insert into public.viva_sessions (user_id, subject, difficulty, question_count, source_type, document_id) values (${A}, 'Bio', 'easy', 3, 'notes', ${DOC_A})`, /viva_sessions_source_consistent/);
      await expectRejected(tx, sql`insert into public.viva_sessions (user_id, subject, difficulty, question_count, source_type) values (${A}, 'Bio', 'easy', 3, 'cloud')`, /viva_sessions_source_type_valid/);
    });
  });

  it("students can read their viva's source but not forge it, and cannot read a question's hidden source reference", async () => {
    await inRolledBackTx(async (tx) => {
      await seed(tx);
      await tx.execute(sql`insert into public.viva_sessions (id, user_id, subject, difficulty, question_count, source_type, document_id) values (${VIVA_A}, ${A}, 'Biology', 'easy', 3, 'document', ${DOC_A})`);
      await tx.execute(sql`insert into public.viva_questions (id, session_id, user_id, question_number, question_text, concept, key_points, source_ref) values (${VIVA_Q}, ${VIVA_A}, ${A}, 1, 'Why?', 'Idea', '["x"]'::jsonb, '{"documentId":"x"}'::jsonb)`);
      await actAs(tx, A);
      expect(rows(await tx.execute(sql`select source_type, document_id from public.viva_sessions where id = ${VIVA_A}`))).toHaveLength(1);
      await expectRejected(tx, sql`update public.viva_sessions set source_type = 'general' where id = ${VIVA_A}`, /permission denied/i);
      await expectRejected(tx, sql`select source_ref from public.viva_questions where id = ${VIVA_Q}`, /permission denied/i);
      await actAs(tx, B);
      expect(rows(await tx.execute(sql`select 1 from public.viva_sessions where id = ${VIVA_A}`))).toHaveLength(0);
    });
  });
});
