import { describe, expect, it, vi } from "vitest";
import type { TutorStreamEvent } from "@copilot/shared";
import { AIError } from "../services/ai/errors.js";
import { OllamaOrMockProvider } from "../services/ai/mock-fallback.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../services/ai/types.js";
import { DEFAULT_TITLE, createTutorService, deriveTitle, type Turn } from "./service.js";
import { createInMemoryTutorRepository } from "./testing.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(ai: LLMProvider = new MockProvider(0), opts: { replyDeadlineMs?: number } = {}) {
  const store = createInMemoryTutorRepository({ [A]: "Alice Smith", [B]: "Bob" });
  const service = createTutorService({ repo: store.repo, ai, ...opts });
  return { ...store, service, ai };
}

async function run(turn: Turn, signal = new AbortController().signal): Promise<TutorStreamEvent[]> {
  const events: TutorStreamEvent[] = [];
  try {
    for await (const e of turn.events(signal)) events.push(e);
  } finally {
    turn.release();
  }
  return events;
}

/** Rejects when the signal aborts (immediately if it already has). */
const untilAborted = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

/** Provider whose behaviour the test scripts; records every request it receives. */
function scripted(
  behaviour: (req: GenerateTextRequest, n: number) => AsyncGenerator<string, void, void> | string[],
): LLMProvider & { requests: GenerateTextRequest[] } {
  const requests: GenerateTextRequest[] = [];
  return {
    name: "mock",
    model: "scripted",
    isMock: true,
    requests,
    async generateText() {
      throw new Error("unused");
    },
    async *streamText(req): TextStream {
      requests.push(req);
      const out = behaviour(req, requests.length);
      for await (const chunk of out as AsyncIterable<string>) yield chunk;
      return {};
    },
  } as LLMProvider & { requests: GenerateTextRequest[] };
}

describe("conversations and ownership", () => {
  it("creates, lists and loads a student's own conversations", async () => {
    const { service } = setup();
    const c1 = await service.createConversation(A, { subject: "Physics", topic: "Thermodynamics", level: "intermediate" });
    const c2 = await service.createConversation(A, {});
    expect(c1).toMatchObject({ title: DEFAULT_TITLE, subject: "Physics", topic: "Thermodynamics", level: "intermediate" });
    expect((await service.listConversations(A)).map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());
    expect((await service.getConversationDetail(A, c1.id)).conversation.id).toBe(c1.id);
  });

  it("student B cannot read, update, delete, send to or regenerate student A's conversation", async () => {
    const { service, msgs } = setup();
    const c = await service.createConversation(A, {});
    await run(await service.startSend(A, c.id, { content: "private question" }));
    const before = msgs.length;

    await expect(service.getConversationDetail(B, c.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.updateConversation(B, c.id, { title: "hacked" })).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteConversation(B, c.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.startSend(B, c.id, { content: "injected" })).rejects.toMatchObject({ status: 404 });
    await expect(service.startRegenerate(B, c.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.listConversations(B)).toEqual([]);
    expect(msgs).toHaveLength(before); // nothing was written
    expect((await service.getConversationDetail(A, c.id)).conversation.title).not.toBe("hacked");
  });

  it("an unknown conversation id looks exactly like someone else's (no existence leak)", async () => {
    const { service } = setup();
    const c = await service.createConversation(A, {});
    const other = await service.getConversationDetail(B, c.id).catch((e) => e);
    const unknown = await service.getConversationDetail(B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc").catch((e) => e);
    expect(other.status).toBe(unknown.status);
    expect(other.message).toBe(unknown.message);
  });

  it("multiple conversations keep independent histories", async () => {
    const ai = scripted(async function* (req) {
      yield `reply to ${req.messages.at(-1)?.content}`;
    });
    const { service } = setup(ai);
    const c1 = await service.createConversation(A, {});
    const c2 = await service.createConversation(A, {});
    await run(await service.startSend(A, c1.id, { content: "alpha" }));
    await run(await service.startSend(A, c2.id, { content: "beta" }));
    await run(await service.startSend(A, c1.id, { content: "gamma" }));
    const d1 = await service.getConversationDetail(A, c1.id);
    const d2 = await service.getConversationDetail(A, c2.id);
    expect(d1.messages.map((m) => m.content)).toEqual(["alpha", "reply to alpha", "gamma", "reply to gamma"]);
    expect(d2.messages.map((m) => m.content)).toEqual(["beta", "reply to beta"]);
    // Conversation 1's second turn must not contain conversation 2's text.
    expect(JSON.stringify(ai.requests.at(-1))).not.toContain("beta");
  });

  it("soft-deleting hides a conversation but keeps its rows", async () => {
    const { service, convs, msgs } = setup();
    const c = await service.createConversation(A, {});
    await run(await service.startSend(A, c.id, { content: "hello" }));
    await service.deleteConversation(A, c.id);
    expect(await service.listConversations(A)).toEqual([]);
    await expect(service.getConversationDetail(A, c.id)).rejects.toMatchObject({ status: 404 });
    expect(convs.get(c.id)?.deletedAt).not.toBeNull(); // retained, not removed
    expect(msgs).toHaveLength(2);
    await expect(service.deleteConversation(A, c.id)).rejects.toMatchObject({ status: 404 });
  });

  it("updates optional subject/topic/level and clears them with null", async () => {
    const { service } = setup();
    const c = await service.createConversation(A, {});
    const u = await service.updateConversation(A, c.id, { subject: "Maths", topic: "Integration", level: "advanced" });
    expect(u).toMatchObject({ subject: "Maths", topic: "Integration", level: "advanced" });
    const cleared = await service.updateConversation(A, c.id, { topic: null, level: null });
    expect(cleared).toMatchObject({ subject: "Maths", topic: null, level: null });
  });
});

describe("sending a message", () => {
  it("emits user_message, streamed deltas, then done, and persists both messages", async () => {
    const { service, msgs } = setup();
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "What is entropy?" }));

    expect(events[0]).toMatchObject({ type: "user_message", message: { role: "user", content: "What is entropy?" } });
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(3);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "done", message: { role: "assistant", isMock: true, model: "mock-demo" } });
    const joined = deltas.map((e) => (e.type === "delta" ? e.text : "")).join("");
    expect(last?.type === "done" && last.message.content).toBe(joined.trim());
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("labels mock answers as mock (never passes them off as real AI)", async () => {
    const { service } = setup();
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    const done = events.at(-1);
    expect(done?.type === "done" && done.message.isMock).toBe(true);
    expect(done?.type === "done" && done.message.content).toContain("[DEMO AI");
  });

  it("when Ollama is not running, the stored reply is the MOCK and is labelled as such, not as a real model", async () => {
    const ollamaDown: LLMProvider = {
      name: "ollama",
      model: "llama3.2:3b",
      isMock: false,
      async generateText() {
        throw new AIError("local_unavailable", "down");
      },
      // eslint-disable-next-line require-yield
      async *streamText(): TextStream {
        throw new AIError("local_unavailable", "down");
      },
    };
    const { service, msgs } = setup(new OllamaOrMockProvider(ollamaDown, 0));
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", message: { isMock: true, model: "mock-demo" } });
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", isMock: true, model: "mock-demo" });
    expect(msgs.at(-1)?.content).toContain("Ollama) is not running");
  });

  it("derives the conversation title from the first message only", async () => {
    const { service } = setup();
    const c = await service.createConversation(A, {});
    await run(await service.startSend(A, c.id, { content: "What is entropy?" }));
    await run(await service.startSend(A, c.id, { content: "And enthalpy?" }));
    expect((await service.getConversationDetail(A, c.id)).conversation.title).toBe("What is entropy?");
    expect(deriveTitle("x".repeat(100))).toHaveLength(60);
    expect(deriveTitle("  multi\n line   text ")).toBe("multi line text");
  });

  it("sends context, level, mode, student name and history to the provider in separate layers", async () => {
    const ai = scripted(async function* () {
      yield "ok";
    });
    const { service } = setup(ai);
    const c = await service.createConversation(A, { subject: "Physics", topic: "Thermodynamics", level: "advanced" });
    await run(await service.startSend(A, c.id, { content: "What is entropy?" }));
    await run(await service.startSend(A, c.id, { content: "Explain the second point.", mode: "step_by_step" }));

    const second = ai.requests[1]!;
    expect(second.system).toContain("Name: Alice Smith");
    expect(second.system).toContain("Subject: Physics");
    expect(second.system).toContain("Topic: Thermodynamics");
    expect(second.system).toContain("Advanced");
    expect(second.system).toContain("Active tutor mode: step_by_step");
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[0]?.content).toBe("What is entropy?");
    expect(second.messages.at(-1)?.content).toBe("Explain the second point.");
  });

  it("stores the chosen mode on the student's message", async () => {
    const { service, msgs } = setup();
    const c = await service.createConversation(A, {});
    await run(await service.startSend(A, c.id, { content: "Quiz me", mode: "test_me" }));
    expect(msgs[0]?.mode).toBe("test_me");
  });

  it("refuses a second message while a reply is still being generated", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const ai = scripted(async function* () {
      await gate;
      yield "late";
    });
    const { service } = setup(ai);
    const c = await service.createConversation(A, {});
    const turn = await service.startSend(A, c.id, { content: "first" });
    const first = run(turn);
    await expect(service.startSend(A, c.id, { content: "second" })).rejects.toMatchObject({ status: 409 });
    await expect(service.startRegenerate(A, c.id)).rejects.toMatchObject({ status: 409 });
    finish();
    await first;
    // Lock released afterwards.
    await expect(service.startSend(A, c.id, { content: "third" })).resolves.toBeDefined();
  });
});

describe("provider failures", () => {
  const failing = (err: unknown) =>
    scripted(async function* () {
      yield "partial";
      throw err;
    });

  it.each([
    [new AIError("rate_limited", "busy", true), "rate_limited", true],
    [new AIError("timeout", "slow", true), "timeout", true],
    [new AIError("auth", "creds", false), "auth", false],
    [new AIError("refused", "no", false), "refused", false],
  ])("turns a provider AIError into an error event (%#)", async (err, code, retryable) => {
    const { service, msgs } = setup(failing(err));
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "error", code, retryable });
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(msgs.map((m) => m.role)).toEqual(["user"]); // student's message kept, no partial reply saved
  });

  it("hides unexpected provider errors behind a generic message and reports them to the logger", async () => {
    const onError = vi.fn();
    const store = createInMemoryTutorRepository();
    const service = createTutorService({ repo: store.repo, ai: failing(new Error("ECONNRESET sk-ant-SECRET")), onError });
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    const err = events.at(-1);
    expect(err).toMatchObject({ type: "error", code: "internal", retryable: true });
    expect(JSON.stringify(err)).not.toMatch(/ECONNRESET|SECRET/);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("treats an empty provider response as a retryable error and saves nothing", async () => {
    const { service, msgs } = setup(scripted(async function* () { yield "   \n "; }));
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "empty_response", retryable: true });
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
  });

  it("treats an absurdly long reply as malformed", async () => {
    const { service } = setup(scripted(async function* () { yield "x".repeat(70_000); }));
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports a timeout when the reply deadline passes", async () => {
    const ai = scripted(async function* (req) {
      await untilAborted(req.signal);
      yield "never";
    });
    const { service } = setup(ai, { replyDeadlineMs: 30 });
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "timeout", retryable: true });
  });

  it("stops quietly (no error event) when the client disconnects, keeping the student's message", async () => {
    const controller = new AbortController();
    const ai = scripted(async function* (req) {
      yield "one ";
      controller.abort();
      await untilAborted(req.signal);
      yield "two";
    });
    const { service, msgs } = setup(ai);
    const c = await service.createConversation(A, {});
    const events = await run(await service.startSend(A, c.id, { content: "hi" }), controller.signal);
    expect(events.some((e) => e.type === "error" || e.type === "done")).toBe(false);
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("retry and regenerate", () => {
  it("retry after a failure answers the saved message without duplicating it", async () => {
    let attempt = 0;
    const ai = scripted(async function* () {
      attempt++;
      if (attempt === 1) throw new AIError("unavailable", "down", true);
      yield "second time works";
    });
    const { service, msgs } = setup(ai);
    const c = await service.createConversation(A, {});
    const first = await run(await service.startSend(A, c.id, { content: "question" }));
    expect(first.at(-1)).toMatchObject({ type: "error" });

    const retry = await run(await service.startRegenerate(A, c.id));
    expect(retry.some((e) => e.type === "user_message")).toBe(false);
    expect(retry.at(-1)).toMatchObject({ type: "done", message: { content: "second time works" } });
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(ai.requests[1]?.messages.at(-1)?.content).toBe("question");
  });

  it("regenerating appends a new reply that supersedes the old one, using the original mode", async () => {
    let n = 0;
    const ai = scripted(async function* () {
      yield `answer ${++n}`;
    });
    const { service, msgs } = setup(ai);
    const c = await service.createConversation(A, {});
    await run(await service.startSend(A, c.id, { content: "Teach me", mode: "hint" }));
    await run(await service.startRegenerate(A, c.id));

    expect(msgs.map((m) => m.content)).toEqual(["Teach me", "answer 1", "answer 2"]); // nothing overwritten
    const detail = await service.getConversationDetail(A, c.id);
    expect(detail.messages.map((m) => m.content)).toEqual(["Teach me", "answer 2"]); // newest wins
    expect(ai.requests[1]?.system).toContain("Active tutor mode: hint");
    // The superseded reply is not sent back to the model as context.
    await run(await service.startSend(A, c.id, { content: "next" }));
    expect(JSON.stringify(ai.requests[2]?.messages)).not.toContain("answer 1");
  });

  it("rejects regenerate on an empty conversation", async () => {
    const { service } = setup();
    const c = await service.createConversation(A, {});
    await expect(service.startRegenerate(A, c.id)).rejects.toMatchObject({ status: 400 });
  });
});
