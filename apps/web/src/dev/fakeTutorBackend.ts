import type { Conversation, TutorMessage, TutorStreamEvent } from "@copilot/shared";

/**
 * In-memory stand-in for the tutor API, used by tests and by the DEV-only /dev/tutor preview.
 * It speaks the real wire protocol (JSON + server-sent events). Never bundled into production:
 * the only non-test importer is the lazy, DEV-gated preview page.
 */

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const enc = new TextEncoder();

export interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

export interface BackendSeed {
  conversations?: Conversation[];
  messages?: Record<string, TutorMessage[]>;
  /** Whether /api/health reports the mock provider (default true). */
  mock?: boolean;
  /** Delay between streamed chunks, to make streaming visible in the preview. */
  chunkDelayMs?: number;
  /** Produce richer Markdown/math/code answers (preview only). */
  richReplies?: boolean;
}

export function makeBackend(seed: BackendSeed = {}) {
  let n = 100;
  const conversations = [...(seed.conversations ?? [])];
  const messages: Record<string, TutorMessage[]> = { ...(seed.messages ?? {}) };
  const calls: Call[] = [];
  const knobs = {
    /** Events (after user_message) for the next generation. Default: a short successful reply. */
    reply: (_content: string): TutorStreamEvent[] | null => null,
    failWith: null as null | { status: number; message: string },
    networkDown: false,
    /** When set, the generation stream is held open and driven by the test. */
    hold: null as null | { push: (e: TutorStreamEvent) => void; close: () => void },
    holdNext: false,
  };

  const now = () => new Date().toISOString();
  const mk = (conversationId: string, role: "user" | "assistant", content: string, extra: Partial<TutorMessage> = {}): TutorMessage => ({
    id: uid(++n),
    conversationId,
    role,
    content,
    mode: null,
    model: role === "assistant" ? "mock-demo" : null,
    isMock: role === "assistant",
    createdAt: now(),
    ...extra,
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const RICH = [
    "Good question. **Entropy** measures how spread out energy is.\n\n",
    "Key ideas:\n\n1. Systems drift toward *more* ways to arrange energy\n2. The second law: $\\Delta S \\ge 0$ for an isolated system\n3. It is statistical, not a force\n\n",
    "For a reversible process:\n\n$$\\Delta S = \\int \\frac{\\delta Q_{rev}}{T}$$\n\n",
    "```python\ndef delta_s(q, t):\n    return q / t\n```\n\n",
    "**Common mistake:** confusing entropy with \"disorder\" in the everyday sense.\n\n",
    "Try this: if $5\\,\\text{J}$ of heat flows reversibly at $300\\,\\text{K}$, what is $\\Delta S$?",
  ];

  function stream(signal: AbortSignal | null | undefined, events: TutorStreamEvent[]) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          let aborted = false;
          signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("Aborted", "AbortError"));
          });
          const write = (e: TutorStreamEvent) => {
            if (!aborted) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          };
          if (knobs.holdNext) {
            knobs.holdNext = false;
            knobs.hold = { push: write, close: () => controller.close() };
            events.filter((e) => e.type === "user_message").forEach(write);
            return;
          }
          for (const e of events) {
            if (aborted) return;
            write(e);
            if (e.type === "delta" && seed.chunkDelayMs) await new Promise((r) => setTimeout(r, seed.chunkDelayMs));
          }
          if (!aborted) controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  function generate(conversationId: string, userContent: string | null, init: RequestInit | undefined, mode: TutorMessage["mode"]) {
    const conv = conversations.find((c) => c.id === conversationId)!;
    const list = (messages[conversationId] ??= []);
    const events: TutorStreamEvent[] = [];
    if (userContent !== null) {
      const um = mk(conversationId, "user", userContent, { mode });
      list.push(um);
      if (conv.title === "New conversation") conv.title = userContent.slice(0, 60);
      events.push({ type: "user_message", message: um });
    }
    const lastUser = [...list].reverse().find((m) => m.role === "user")!;
    const scripted = knobs.reply(lastUser.content);
    if (scripted) {
      events.push(...scripted);
    } else {
      const chunks = seed.richReplies ? RICH : [`Answer to: ${lastUser.content}`];
      const text = chunks.join("");
      const am = mk(conversationId, "assistant", text, { isMock: seed.mock ?? true });
      if (seed.richReplies) chunks.forEach((c) => events.push({ type: "delta", text: c }));
      else events.push({ type: "delta", text: text.slice(0, 8) }, { type: "delta", text: text.slice(8) });
      list.push(am);
      conv.updatedAt = now();
      events.push({ type: "done", message: am, conversation: { ...conv } });
    }
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
    if (url === "/api/tutor/conversations" && method === "GET") {
      return json({ conversations: [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }
    if (url === "/api/tutor/conversations" && method === "POST") {
      const c: Conversation = {
        id: uid(++n),
        title: "New conversation",
        subject: (body?.subject as string) ?? null,
        topic: (body?.topic as string) ?? null,
        level: (body?.level as Conversation["level"]) ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      conversations.unshift(c);
      messages[c.id] = [];
      return json({ conversation: c }, 201);
    }
    const m = /^\/api\/tutor\/conversations\/([^/]+)(\/messages|\/regenerate)?$/.exec(url);
    if (m) {
      const id = m[1]!;
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return json({ error: "not_found", message: "Conversation not found." }, 404);
      if (m[2] === "/messages" || m[2] === "/regenerate") {
        if (knobs.failWith) return json({ error: "x", message: knobs.failWith.message }, knobs.failWith.status);
        return generate(id, m[2] === "/messages" ? String(body?.content) : null, init, (body?.mode as TutorMessage["mode"]) ?? null);
      }
      if (method === "GET") return json({ conversation: conv, messages: messages[id] ?? [] });
      if (method === "PATCH") {
        Object.assign(conv, body);
        return json({ conversation: conv });
      }
      if (method === "DELETE") {
        conversations.splice(conversations.indexOf(conv), 1);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: "nope", message: `Unhandled ${method} ${url}` }, 500);
  };

  return { fetchMock, calls, conversations, messages, knobs, mk };
}
