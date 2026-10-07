import { describe, expect, it } from "vitest";
import { NOTE_LIMITS, noteSchema, tutorStreamEventSchema, type TutorStreamEvent } from "@copilot/shared";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createInMemoryNotesRepository, createFakeStorage } from "../notes/testing/memory.js";
import { makePdf } from "../notes/testing/pdf.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const bearer = (id: string) => ({ authorization: `Bearer token:${id}` });
const verifyToken = async (t: string) => (t === `token:${A}` ? { id: A, email: "a@example.com" } : t === `token:${B}` ? { id: B, email: "b@example.com" } : null);
const env = loadEnv({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", SUPABASE_URL: "https://example.supabase.co", NODE_ENV: "test" });

const DOC = `# Biology\n\n## Photosynthesis\n\n${"Photosynthesis converts light energy into chemical energy in the chloroplasts of plant cells. ".repeat(8)}\n\n## Mitosis\n\n${"Mitosis produces two identical daughter cells through four phases. ".repeat(8)}`;

async function make() {
  const tutorStore = createInMemoryTutorRepository({ [A]: "Alice", [B]: "Bob" });
  const notes = createInMemoryNotesRepository(tutorStore);
  const fake = createFakeStorage();
  const app = await buildApp({
    env,
    db: {} as unknown as Database,
    ai: new MockProvider(0),
    verifyToken,
    tutorRepo: tutorStore.repo,
    notesRepo: notes.repo,
    notesStorage: fake.storage,
  });
  return { app, notes, fake, tutorStore };
}

/** Builds a multipart/form-data body by hand. */
function multipart(parts: Array<{ name: string; filename?: string; type?: string; data: Uint8Array | string }>) {
  const boundary = "----testboundary7MA4YWxkTrZu0gW";
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const p of parts) {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`;
    chunks.push(enc.encode(head), typeof p.data === "string" ? enc.encode(p.data) : p.data, enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = Buffer.alloc(total);
  let at = 0;
  for (const c of chunks) (body.set(c, at), (at += c.length));
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const file = (filename: string, data: Uint8Array | string, type = "application/octet-stream") => multipart([{ name: "file", filename, type, data }]);

type App = Awaited<ReturnType<typeof make>>["app"];
async function post(app: App, who: string, f: ReturnType<typeof file>) {
  return app.inject({ method: "POST", url: "/api/notes", headers: { ...bearer(who), ...f.headers }, payload: f.payload });
}

const parseSse = (body: string): TutorStreamEvent[] =>
  body.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => tutorStreamEventSchema.parse(JSON.parse(f.slice(6))));

describe("notes routes: authentication", () => {
  it.each([
    ["GET", "/api/notes"],
    ["POST", "/api/notes"],
    ["POST", "/api/notes/text"],
    ["GET", `/api/notes/${A}`],
    ["GET", `/api/notes/${A}/content`],
    ["POST", `/api/notes/${A}/process`],
    ["DELETE", `/api/notes/${A}`],
    ["GET", `/api/notes/${A}/conversation`],
    ["POST", `/api/notes/${A}/assistant`],
    ["POST", `/api/notes/${A}/assistant/regenerate`],
  ])("%s %s requires a signed-in student", async (method, url) => {
    const { app } = await make();
    for (const headers of [{}, { authorization: "Bearer forged" }]) {
      const res = await app.inject({ method: method as "GET", url, headers, payload: method === "GET" || method === "DELETE" ? undefined : {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
    await app.close();
  });
});

describe("notes routes: upload", () => {
  it("accepts a valid Markdown file and returns the READY note without any internal fields", async () => {
    const { app, fake } = await make();
    const res = await post(app, A, file("biology.md", DOC, "text/markdown"));
    expect(res.statusCode).toBe(201);
    const { note } = res.json();
    expect(noteSchema.parse(note)).toMatchObject({ status: "ready", fileType: "md", title: "biology" });
    // Nothing internal leaks: no storage path, hash or owner id.
    expect(Object.keys(note).sort()).toEqual(Object.keys(noteSchema.shape).sort());
    expect(JSON.stringify(res.json())).not.toMatch(new RegExp(`${A}|original\\.md|content_?[Hh]ash`));
    expect(fake.objects.size).toBe(1);
    await app.close();
  });

  it("accepts a valid PDF", async () => {
    const { app } = await make();
    const res = await post(app, A, file("Lecture 1.pdf", makePdf([["Chapter 1: Cells", "Cells are the basic unit of life and come in many kinds."]]), "application/pdf"));
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toMatchObject({ status: "ready", fileType: "pdf", pageCount: 1, title: "Lecture 1" });
    await app.close();
  });

  it("trusts the file's CONTENT, not the MIME type the browser claims", async () => {
    const { app } = await make();
    const res = await post(app, A, file("notes.pdf", "plain text pretending to be a pdf", "application/pdf"));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not a valid PDF/);
    await app.close();
  });

  it.each([
    ["an empty file", file("e.txt", ""), 400, /empty/i],
    ["an unsupported type", file("essay.docx", "hello"), 415, /Unsupported file type/],
    ["a PDF disguised as .txt", file("x.txt", makePdf([["hello world"]])), 400, /PDF with a text-file name/],
  ])("rejects %s", async (_label, f, status, message) => {
    const { app, fake } = await make();
    const res = await post(app, A, f);
    expect(res.statusCode).toBe(status);
    expect(res.json().message).toMatch(message);
    expect(fake.objects.size).toBe(0);
    await app.close();
  });

  it("rejects an oversized file with 413 and a friendly message", async () => {
    const { app, fake } = await make();
    const res = await post(app, A, file("huge.txt", new Uint8Array(NOTE_LIMITS.maxFileBytes + 1024).fill(97), "text/plain"));
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/larger than 10 MB/);
    expect(fake.objects.size).toBe(0);
    await app.close();
  });

  it("rejects a non-multipart body and a multipart body with no file", async () => {
    const { app } = await make();
    const json = await app.inject({ method: "POST", url: "/api/notes", headers: bearer(A), payload: { text: "hello" } });
    expect(json.statusCode).toBe(415);
    const none = multipart([{ name: "title", data: "just a field" }]);
    const res = await app.inject({ method: "POST", url: "/api/notes", headers: { ...bearer(A), ...none.headers }, payload: none.payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/No file/);
    await app.close();
  });

  it("answers a duplicate upload with 409 and the id of the existing note", async () => {
    const { app } = await make();
    const first = (await post(app, A, file("a.md", DOC))).json().note;
    const dup = await post(app, A, file("copy-of-a.md", DOC));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: "duplicate_note", noteId: first.id });
    await app.close();
  });

  it("reports a failed storage write as 502 without leaking details and leaves nothing in the library", async () => {
    const { app, fake } = await make();
    fake.failures.upload = Object.assign(new Error("secret bucket detail"), { name: "StorageError", status: 500 }) as never;
    const res = await post(app, A, file("a.md", DOC));
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/secret|bucket/);
    expect((await app.inject({ url: "/api/notes", headers: bearer(A) })).json().notes).toEqual([]);
    await app.close();
  });

  it("a processing failure is a normal 201 with a FAILED note the student can act on", async () => {
    const { app } = await make();
    const res = await post(app, A, file("scan.pdf", makePdf([[" "]]), "application/pdf"));
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toMatchObject({ status: "failed" });
    expect(res.json().note.error).toMatch(/image-only pages/);
    await app.close();
  });

  it("accepts pasted text and validates it", async () => {
    const { app } = await make();
    const ok = await app.inject({ method: "POST", url: "/api/notes/text", headers: bearer(A), payload: { title: "My cell notes", text: "Cells are the basic unit of life. ".repeat(10) } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().note).toMatchObject({ status: "ready", source: "paste", title: "My cell notes" });
    for (const payload of [{ text: "" }, { text: "   " }, {}, { text: "x".repeat(NOTE_LIMITS.maxPastedChars + 1) }, { text: 5 }]) {
      const bad = await app.inject({ method: "POST", url: "/api/notes/text", headers: bearer(A), payload });
      expect(bad.statusCode).toBe(400);
    }
    await app.close();
  });
});

describe("notes routes: library and content", () => {
  it("lists, searches, filters and validates the query", async () => {
    const { app } = await make();
    await post(app, A, file("physics.md", DOC.replace("Biology", "Physics").replace("Photosynthesis", "Energy")));
    await post(app, A, file("biology.md", DOC));
    const names = async (q: string) => (await app.inject({ url: `/api/notes${q}`, headers: bearer(A) })).json().notes.map((n: { title: string }) => n.title);
    expect(await names("")).toHaveLength(2);
    expect(await names("?q=physics")).toEqual(["physics"]);
    expect(await names("?type=pdf")).toEqual([]);
    expect(await names("?status=ready&sort=name")).toEqual(["biology", "physics"]);
    for (const bad of ["?type=docx", "?limit=0", "?limit=1000", "?sort=random", "?status=done"]) {
      expect((await app.inject({ url: `/api/notes${bad}`, headers: bearer(A) })).statusCode).toBe(400);
    }
    await app.close();
  });

  it("pages the content and rejects bad ids / cursors", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    const page = (await app.inject({ url: `/api/notes/${note.id}/content?limit=1`, headers: bearer(A) })).json();
    expect(page.chunks).toHaveLength(1);
    expect(page.total).toBe(note.chunkCount);
    expect(page.nextCursor).toBe(1);
    expect((await app.inject({ url: `/api/notes/${note.id}/content?limit=999`, headers: bearer(A) })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/notes/${note.id}/content?cursor=-1`, headers: bearer(A) })).statusCode).toBe(400);
    for (const id of ["nope", "123", `${note.id}x`]) expect((await app.inject({ url: `/api/notes/${id}`, headers: bearer(A) })).statusCode).toBe(400);
    const detail = (await app.inject({ url: `/api/notes/${note.id}`, headers: bearer(A) })).json();
    expect(detail.outline.map((o: { heading: string }) => o.heading)).toContain("Photosynthesis");
    await app.close();
  });

  it("soft delete answers 204 and then 404", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    expect((await app.inject({ method: "DELETE", url: `/api/notes/${note.id}`, headers: bearer(A) })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/notes/${note.id}`, headers: bearer(A) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/notes", headers: bearer(A) })).json().notes).toEqual([]);
    await app.close();
  });
});

describe("notes routes: the AI study assistant", () => {
  it("streams a document-grounded answer over SSE and persists it with real source references", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action: "ask", question: "What is mitosis?" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body);
    expect(events[0]?.type).toBe("user_message");
    expect(events.at(-1)?.type).toBe("done");
    const done = events.at(-1);
    if (done?.type === "done") {
      expect(done.message.sources?.length).toBeGreaterThan(0);
      expect(done.message.isMock).toBe(true); // labelled: no real model in this test
    }
    const convo = (await app.inject({ url: `/api/notes/${note.id}/conversation`, headers: bearer(A) })).json();
    expect(convo.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(convo.messages[0]).toMatchObject({ action: "ask", content: "What is mitosis?" });
    await app.close();
  });

  it.each([
    ["ask without a question", { action: "ask" }],
    ["ask with a blank question", { action: "ask", question: "   " }],
    ["an unknown action", { action: "hack" }],
    ["no action", {}],
    ["an over-long question", { action: "ask", question: "x".repeat(NOTE_LIMITS.questionMaxChars + 1) }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_input");
    await app.close();
  });

  it("refuses a huge request body with 413", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action: "ask", question: "x".repeat(50_000) } });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("runs every study action over HTTP", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    for (const action of ["explain", "summarize", "key_concepts", "definitions", "formulas", "flashcards", "quiz", "important_topics"]) {
      const res = await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action } });
      expect(res.statusCode).toBe(200);
      expect(parseSse(res.body).at(-1)?.type).toBe("done");
    }
    await app.close();
  });

  it("limits generation per client with a friendly 429", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action: "summarize" } })).statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
    await app.close();
  });
});

describe("notes routes: cross-user isolation over HTTP", () => {
  it("student B gets 404 and no content for every operation on student A's note", async () => {
    const { app, fake, notes } = await make();
    const note = (await post(app, A, file("secret-plan.md", DOC))).json().note;
    await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action: "summarize" } });
    const storedBefore = fake.objects.size;
    const u = `/api/notes/${note.id}`;

    const results = await Promise.all([
      app.inject({ url: u, headers: bearer(B) }),
      app.inject({ url: `${u}/content`, headers: bearer(B) }),
      app.inject({ url: `${u}/conversation`, headers: bearer(B) }),
      app.inject({ method: "POST", url: `${u}/process`, headers: bearer(B) }),
      app.inject({ method: "DELETE", url: u, headers: bearer(B) }),
      app.inject({ method: "POST", url: `${u}/assistant`, headers: bearer(B), payload: { action: "ask", question: "what do their notes say?" } }),
      app.inject({ method: "POST", url: `${u}/assistant/regenerate`, headers: bearer(B) }),
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toMatch(/Photosynthesis|Mitosis|secret-plan/);
    }
    expect((await app.inject({ url: "/api/notes", headers: bearer(B) })).json().notes).toEqual([]);
    expect(fake.objects.size).toBe(storedBefore);
    expect(notes.docs.get(note.id)?.deletedAt).toBeNull(); // B's DELETE did nothing
    await app.close();
  });

  it("the tutor never lists or opens a notes conversation (the two chats stay separate)", async () => {
    const { app } = await make();
    const note = (await post(app, A, file("biology.md", DOC))).json().note;
    await app.inject({ method: "POST", url: `/api/notes/${note.id}/assistant`, headers: bearer(A), payload: { action: "summarize" } });
    const convoId = (await app.inject({ url: `/api/notes/${note.id}/conversation`, headers: bearer(A) })).json().conversation.id;
    expect((await app.inject({ url: "/api/tutor/conversations", headers: bearer(A) })).json().conversations).toEqual([]);
    expect((await app.inject({ url: `/api/tutor/conversations/${convoId}`, headers: bearer(A) })).statusCode).toBe(404);
    await app.close();
  });
});
