import type { Note, NoteChunk, SourceRef, TutorMessage, TutorStreamEvent } from "@copilot/shared";

/**
 * In-memory stand-in for the notes API (JSON + SSE + multipart upload), used by tests and by the
 * DEV-only /dev/notes preview. Never bundled into production: its only non-test importer is the
 * lazy, DEV-gated preview page.
 */

export const nid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const enc = new TextEncoder();

export interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

export interface NotesSeed {
  notes?: Note[];
  chunks?: Record<string, NoteChunk[]>;
  mock?: boolean;
  chunkDelayMs?: number;
}

export function makeNote(n: number, extra: Partial<Note> = {}): Note {
  const t = new Date(Date.UTC(2026, 9, 3, 10, n)).toISOString();
  return {
    id: nid(n),
    title: `Note ${n}`,
    originalFilename: `note-${n}.pdf`,
    fileType: "pdf",
    source: "upload",
    fileSize: 120_000,
    status: "ready",
    error: null,
    pageCount: 4,
    chunkCount: 3,
    createdAt: t,
    updatedAt: t,
    lastActivityAt: t,
    ...extra,
  };
}

export function makeChunks(count: number, prefix = "Section"): NoteChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    page: Math.floor(i / 2) + 1,
    pageEnd: null,
    heading: `${prefix} ${i + 1}`,
    content: `Body text of ${prefix.toLowerCase()} ${i + 1}. Entropy is a measure of disorder.`,
  }));
}

export function makeBackend(seed: NotesSeed = {}) {
  let n = 500;
  const notes = [...(seed.notes ?? [])];
  const chunks: Record<string, NoteChunk[]> = { ...(seed.chunks ?? {}) };
  const messages: Record<string, TutorMessage[]> = {};
  const calls: Call[] = [];
  const knobs = {
    networkDown: false,
    failAssistant: null as null | { status: number; message: string },
    /** Scripted assistant reply for the next request: text + the sources the server "retrieved". */
    reply: null as null | { text: string; sources: SourceRef[]; isMock?: boolean },
    /** Used for every request when no one-shot `reply` is queued (preview only). */
    autoReply: null as null | ((userContent: string) => { text: string; sources: SourceRef[]; isMock?: boolean }),
    /** Upload behaviour: "auto" finishes by itself, "hold" waits for the test to drive it. */
    upload: "auto" as "auto" | "hold",
    uploadError: null as null | { status: number; body: Record<string, unknown> },
  };
  const now = () => new Date().toISOString();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const mkMsg = (noteId: string, role: "user" | "assistant", content: string, extra: Partial<TutorMessage> = {}): TutorMessage => ({
    id: nid(++n),
    conversationId: nid(9000),
    role,
    content,
    mode: null,
    model: role === "assistant" ? (seed.mock === false ? "llama3.2:3b" : "mock-demo") : null,
    isMock: role === "assistant" ? (seed.mock ?? true) : false,
    createdAt: now(),
    ...extra,
  });

  function addNote(file: { name: string; size: number; type?: "pdf" | "txt" | "md" }, title?: string): Note | Response {
    const dup = notes.find((x) => x.originalFilename === file.name);
    if (dup) return json({ error: "duplicate_note", message: `You already uploaded this as "${dup.title}".`, noteId: dup.id }, 409);
    const note = makeNote(++n, {
      title: title ?? file.name.replace(/\.[^.]+$/, ""),
      originalFilename: file.name,
      fileType: file.type ?? "pdf",
      fileSize: file.size,
      createdAt: now(),
      lastActivityAt: now(),
    });
    notes.unshift(note);
    chunks[note.id] = makeChunks(note.chunkCount);
    return note;
  }

  const outlineOf = (id: string) => (chunks[id] ?? []).filter((c) => c.heading).map((c) => ({ chunkIndex: c.index, heading: c.heading!, page: c.page }));

  function stream(signal: AbortSignal | null | undefined, events: TutorStreamEvent[]) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          let aborted = false;
          signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("Aborted", "AbortError"));
          });
          for (const e of events) {
            if (aborted) return;
            controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            if (e.type === "delta" && seed.chunkDelayMs) await new Promise((r) => setTimeout(r, seed.chunkDelayMs));
          }
          if (!aborted) controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  function assistant(noteId: string, body: Record<string, unknown> | null, regenerate: boolean, init: RequestInit | undefined) {
    const list = (messages[noteId] ??= []);
    const events: TutorStreamEvent[] = [];
    if (!regenerate) {
      const content = body?.action === "ask" ? String(body.question) : `[action:${String(body?.action)}]`;
      const um = mkMsg(noteId, "user", content, { action: String(body?.action) });
      list.push(um);
      events.push({ type: "user_message", message: um });
    }
    const lastUser = [...list].reverse().find((m) => m.role === "user")!;
    const reply = knobs.reply ?? knobs.autoReply?.(lastUser.content) ?? null;
    knobs.reply = null;
    const text = reply?.text ?? `Answer about: ${lastUser.content}`;
    const am = mkMsg(noteId, "assistant", text, { sources: reply?.sources ?? [], ...(reply?.isMock !== undefined ? { isMock: reply.isMock } : {}) });
    events.push({ type: "delta", text: text.slice(0, 6) }, { type: "delta", text: text.slice(6) });
    list.push(am);
    events.push({
      type: "done",
      message: am,
      conversation: { id: nid(9000), title: "Notes", subject: null, topic: null, level: null, createdAt: now(), updatedAt: now() },
    });
    return stream(init?.signal, events);
  }

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (knobs.networkDown) throw new TypeError("Failed to fetch");

    if (url === "/api/health") {
      return json({ status: "ok", ai: { provider: seed.mock === false ? "ollama" : "mock", isMock: seed.mock ?? true, model: seed.mock === false ? "llama3.2:3b" : "mock-demo" } });
    }

    const [path, query = ""] = url.split("?");
    const params = new URLSearchParams(query);

    if (path === "/api/notes" && method === "GET") {
      const q = params.get("q")?.toLowerCase();
      let out = notes.filter(
        (x) =>
          (!q || x.title.toLowerCase().includes(q) || x.originalFilename.toLowerCase().includes(q)) &&
          (!params.get("type") || x.fileType === params.get("type")) &&
          (!params.get("status") || x.status === params.get("status")),
      );
      const sort = params.get("sort") ?? "recent";
      out = [...out].sort((a, b) =>
        sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : sort === "name" ? a.title.localeCompare(b.title) : sort === "activity" ? b.lastActivityAt.localeCompare(a.lastActivityAt) : b.createdAt.localeCompare(a.createdAt),
      );
      return json({ notes: out });
    }
    if (path === "/api/notes/text" && method === "POST") {
      const text = String(body?.text ?? "");
      const r = addNote({ name: `pasted-${text.length}.txt`, size: text.length, type: "txt" }, (body?.title as string) || "Pasted notes");
      return r instanceof Response ? r : json({ note: r }, 201);
    }

    const m = /^\/api\/notes\/([^/]+)(\/content|\/process|\/conversation|\/assistant\/regenerate|\/assistant)?$/.exec(path ?? "");
    if (m) {
      const id = m[1]!;
      const note = notes.find((x) => x.id === id);
      if (!note) return json({ error: "not_found", message: "Note not found." }, 404);
      switch (m[2]) {
        case undefined:
          if (method === "DELETE") {
            notes.splice(notes.indexOf(note), 1);
            return new Response(null, { status: 204 });
          }
          return json({ note, outline: outlineOf(id) });
        case "/content": {
          const all = chunks[id] ?? [];
          const cursor = Number(params.get("cursor") ?? 0);
          const limit = Number(params.get("limit") ?? 20);
          const page = all.slice(cursor, cursor + limit);
          const next = cursor + limit < all.length ? cursor + limit : null;
          return json({ chunks: page, nextCursor: next, total: all.length });
        }
        case "/process":
          Object.assign(note, { status: "ready", error: null, chunkCount: 3 });
          chunks[id] = makeChunks(3);
          return json({ note });
        case "/conversation":
          return json({ conversation: null, messages: messages[id] ?? [] });
        case "/assistant":
        case "/assistant/regenerate":
          if (knobs.failAssistant) return json({ error: "x", message: knobs.failAssistant.message }, knobs.failAssistant.status);
          return assistant(id, body, m[2] === "/assistant/regenerate", init);
      }
    }
    return json({ error: "nope", message: `Unhandled ${method} ${url}` }, 500);
  };

  /* --------------------------- XMLHttpRequest stand-in (uploads) --------------------------- */

  const held: { current: null | { progress: (loaded: number, total: number) => void; finish: () => void; fail: (status: number, body: unknown) => void; aborted: boolean } } = { current: null };

  class FakeXHR {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private url = "";
    private finished = false;
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    abort() {
      if (this.finished) return;
      this.finished = true;
      if (held.current) held.current.aborted = true;
      this.onabort?.();
    }
    send(form: FormData) {
      const file = form.get("file") as File;
      calls.push({ method: "POST", url: this.url, body: { file: file.name, size: file.size } });
      const respond = (status: number, body: unknown) => {
        if (this.finished) return;
        this.finished = true;
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      };
      const complete = () => {
        const type = /\.md$/i.test(file.name) ? "md" : /\.txt$/i.test(file.name) ? "txt" : "pdf";
        const r = addNote({ name: file.name, size: file.size, type });
        if (r instanceof Response) {
          void r.json().then((b) => respond(409, b));
        } else respond(201, { note: r });
      };
      if (knobs.networkDown) return void queueMicrotask(() => !this.finished && this.onerror?.());
      if (knobs.uploadError) {
        const e = knobs.uploadError;
        return void queueMicrotask(() => respond(e.status, e.body));
      }
      if (knobs.upload === "hold") {
        held.current = {
          aborted: false,
          progress: (loaded, total) => this.upload.onprogress?.({ lengthComputable: true, loaded, total }),
          finish: complete,
          fail: respond,
        };
        return;
      }
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size });
        complete();
      });
    }
  }

  return { fetchMock, FakeXHR, held, calls, notes, chunks, messages, knobs, addNote, mk: mkMsg };
}
