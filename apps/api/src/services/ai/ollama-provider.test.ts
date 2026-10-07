import { describe, expect, it, vi } from "vitest";
import { AIError } from "./errors.js";
import { OllamaProvider, PolicyViolation, assertLocalModel, assertLocalOllamaUrl } from "./ollama-provider.js";
import type { TextStream } from "./types.js";

const enc = new TextEncoder();
const line = (o: object) => JSON.stringify(o);

/** A Response whose body arrives in exactly the given chunks (so we can split mid-line). */
function body(chunks: string[], opts: { failAfter?: Error } = {}): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        if (opts.failAfter) c.error(opts.failAfter);
        else c.close();
      },
    }),
    { status: 200 },
  );
}

function make(fetchImpl: typeof fetch, extra: { timeoutMs?: number; model?: string } = {}) {
  return new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: extra.model ?? "llama3.2:3b", timeoutMs: extra.timeoutMs ?? 5000, numCtx: 8192, fetchImpl });
}

async function drain(stream: TextStream) {
  const parts: string[] = [];
  while (true) {
    const n = await stream.next();
    if (n.done) return { text: parts.join(""), end: n.value };
    parts.push(n.value);
  }
}

const req = { system: "SYS", messages: [{ role: "user" as const, content: "hi" }] };

describe("OllamaProvider requests", () => {
  it("sends one local request with no credentials, system prompt first, and a bounded context", async () => {
    const f = vi.fn(async (..._a: Parameters<typeof fetch>) => body([line({ message: { content: "ok" }, done: false }) + "\n", line({ done: true }) + "\n"]));
    await drain(make(f as unknown as typeof fetch).streamText({ ...req, maxTokens: 123 }));

    expect(f).toHaveBeenCalledTimes(1); // no automatic retries
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(init?.method).toBe("POST");
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|api-key|bearer/i);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "llama3.2:3b",
      stream: true,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ],
      options: { num_ctx: 8192, num_predict: 123 },
    });
  });
});

describe("OllamaProvider streaming", () => {
  it("reassembles NDJSON split at arbitrary byte boundaries and reports usage and provenance", async () => {
    const full = [line({ message: { content: "Hel" } }), line({ message: { content: "lo " } }), line({ message: { content: "world" } }), line({ done: true, prompt_eval_count: 9, eval_count: 4 })].join("\n") + "\n";
    const chunks = [full.slice(0, 10), full.slice(10, 47), full.slice(47, 48), full.slice(48)];
    const { text, end } = await drain(make((async () => body(chunks)) as unknown as typeof fetch).streamText(req));
    expect(text).toBe("Hello world");
    expect(end.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(end.produced).toEqual({ model: "llama3.2:3b", isMock: false });
  });

  it("tolerates blank lines and a final line without a trailing newline", async () => {
    const chunks = [line({ message: { content: "a" } }) + "\n\n", line({ message: { content: "b" }, done: false })];
    const { text } = await drain(make((async () => body(chunks)) as unknown as typeof fetch).streamText(req));
    expect(text).toBe("ab");
  });

  it("generateText joins the stream and rejects an empty answer", async () => {
    const ok = make((async () => body([line({ message: { content: " Hi " } }) + "\n", line({ done: true }) + "\n"])) as unknown as typeof fetch);
    await expect(ok.generateText(req)).resolves.toMatchObject({ text: "Hi", provider: "ollama", isMock: false });
    const empty = make((async () => body([line({ message: { content: "  " } }) + "\n", line({ done: true }) + "\n"])) as unknown as typeof fetch);
    await expect(empty.generateText(req)).rejects.toMatchObject({ code: "empty_response" });
  });
});

describe("OllamaProvider failures (never a paid fallback)", () => {
  it("reports 'not running' as local_unavailable and does not retry", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await drain(make(f as unknown as typeof fetch).streamText(req)).catch((e) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err).toMatchObject({ code: "local_unavailable" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a missing model is a clear, actionable error (not a fallback)", async () => {
    const err = await drain(make((async () => new Response("{}", { status: 404 })) as unknown as typeof fetch, { model: "qwen2.5:7b" }).streamText(req)).catch((e) => e);
    expect(err).toMatchObject({ code: "bad_request" });
    expect(err.message).toContain("ollama pull qwen2.5:7b");
  });

  it("maps server errors, error lines and garbage to safe errors", async () => {
    expect(await drain(make((async () => new Response("boom secret", { status: 500 })) as unknown as typeof fetch).streamText(req)).catch((e) => e)).toMatchObject({ code: "unavailable", retryable: true });
    const errLine = await drain(make((async () => body([line({ error: "internal secret path /home/x" }) + "\n"])) as unknown as typeof fetch).streamText(req)).catch((e) => e);
    expect(errLine).toMatchObject({ code: "unavailable" });
    expect(errLine.message).not.toMatch(/secret|home/);
    expect(await drain(make((async () => body(["not json\n"])) as unknown as typeof fetch).streamText(req)).catch((e) => e)).toMatchObject({ code: "unknown" });
  });

  it("a dropped connection mid-reply is an error, not a silent truncation", async () => {
    const f = (async () => body([line({ message: { content: "partial" } }) + "\n"], { failAfter: new Error("reset") })) as unknown as typeof fetch;
    const err = await drain(make(f).streamText(req)).catch((e) => e);
    expect(err).toMatchObject({ code: "unavailable" });
  });

  it("times out instead of hanging", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const err = await drain(make(hang, { timeoutMs: 30 }).streamText(req)).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("a per-request time limit overrides the provider default (quiz generation is slow on a CPU)", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    const err = await drain(make(hang, { timeoutMs: 60_000 }).streamText({ ...req, timeoutMs: 30 })).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a caller-initiated abort propagates as an abort, not a provider error", async () => {
    const controller = new AbortController();
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))) as unknown as typeof fetch;
    const p = drain(make(hang).streamText({ ...req, signal: controller.signal })).catch((e) => e);
    controller.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(AIError);
    expect(err.name).toBe("AbortError");
  });
});

describe("local-only guards", () => {
  it.each(["http://localhost:11434", "http://127.0.0.1:11434", "http://127.0.0.1:12345/", "http://[::1]:11434"])("accepts loopback %s", (url) => {
    expect(() => assertLocalOllamaUrl(url)).not.toThrow();
  });

  it.each(["https://api.openai.com/v1", "https://api.anthropic.com", "https://ollama.com", "http://10.0.0.5:11434", "http://my-gpu-box:11434", "ftp://localhost", "not a url", "http://user:pass@localhost:11434"])(
    "rejects %s",
    (url) => {
      expect(() => assertLocalOllamaUrl(url)).toThrow(PolicyViolation);
    },
  );

  it.each(["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "kimi-k2:1t-cloud", "model:cloud", "deepseek-v3.1:671b-cloud"])("rejects cloud model %s", (m) => {
    expect(() => assertLocalModel(m)).toThrow(PolicyViolation);
  });

  it.each(["llama3.2:3b", "qwen2.5:7b-instruct", "deepseek-r1:8b", "gemma3:4b", "mistral", "phi3:mini", "cloudy-name:7b"])("accepts local model %s", (m) => {
    expect(assertLocalModel(m)).toBe(m);
  });
});
