import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSISTANT_ACTION_INFO, type AssistantInput, type TutorMessage } from "@copilot/shared";
import { ApiError } from "../../lib/api";
import { getNoteConversation, streamAssistant } from "../../lib/notesApi";

export interface AssistantError {
  code: string;
  message: string;
  retryable: boolean;
  reauth?: boolean;
}

type Phase = "loading" | "idle" | "streaming";

/** A regenerated reply supersedes the previous one (same rule as the server). */
function collapse(messages: TutorMessage[]): TutorMessage[] {
  const out: TutorMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") out[out.length - 1] = m;
    else out.push(m);
  }
  return out;
}

function toError(err: unknown): AssistantError {
  if (err instanceof ApiError) {
    if (err.status === 401) return { code: "auth", message: "Your session has expired. Please sign in again.", retryable: false, reauth: true };
    if (err.status === 0) return { code: "network", message: err.message, retryable: true };
    return { code: `http_${err.status}`, message: err.message, retryable: err.status === 429 || err.status >= 500 };
  }
  return { code: "unknown", message: "Something went wrong. Please try again.", retryable: true };
}

let tempCounter = 0;

/** The study assistant for one document: its own conversation, streamed answers, retry/regenerate. */
export function useNotesAssistant(client: SupabaseClient, noteId: string, enabled: boolean) {
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<AssistantError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const epoch = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const last = useRef<{ input: AssistantInput; saved: boolean } | null>(null);

  const cancel = useCallback(() => {
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
  }, []);

  const load = useCallback(async () => {
    const mine = ++epoch.current;
    setPhase("loading");
    setLoadError(null);
    setError(null);
    setMessages([]);
    setStreamingText(null);
    last.current = null;
    try {
      const res = await getNoteConversation(client, noteId);
      if (epoch.current !== mine) return;
      setMessages(res.messages);
      setPhase("idle");
    } catch (err) {
      if (epoch.current !== mine) return;
      setLoadError(toError(err).message);
      setPhase("idle");
    }
  }, [client, noteId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return cancel;
  }, [enabled, load, cancel]);

  const run = useCallback(
    async (input: { kind: "ask"; request: AssistantInput } | { kind: "regenerate" }) => {
      const mine = epoch.current;
      const alive = () => epoch.current === mine;
      const controller = new AbortController();
      abort.current = controller;
      stopRequested.current = false;
      setPhase("streaming");
      setStreamingText("");
      setRegenerating(input.kind === "regenerate");
      setError(null);

      let buffer = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (alive()) setStreamingText(buffer);
      };
      let finished = false;
      let failed = false;
      try {
        for await (const event of streamAssistant(client, noteId, input, controller.signal)) {
          if (!alive()) return;
          switch (event.type) {
            case "user_message":
              if (last.current) last.current.saved = true;
              setMessages((prev) => [...prev.filter((m) => !m.id.startsWith("tmp-")), event.message]);
              break;
            case "delta":
              buffer += event.text;
              if (!frame) frame = requestAnimationFrame(flush);
              break;
            case "done":
              finished = true;
              if (frame) cancelAnimationFrame(frame);
              setMessages((prev) => collapse([...prev, event.message]));
              break;
            case "error":
              failed = true;
              setError({ code: event.code, message: event.message, retryable: event.retryable });
              break;
          }
        }
        if (alive() && !finished && !failed) {
          setError(
            stopRequested.current
              ? { code: "stopped", message: "Response stopped.", retryable: true }
              : { code: "interrupted", message: "The connection ended before the assistant finished answering.", retryable: true },
          );
        }
      } catch (err) {
        if (alive()) setError(toError(err));
      } finally {
        if (frame) cancelAnimationFrame(frame);
        if (alive()) {
          setStreamingText(null);
          setRegenerating(false);
          setPhase("idle");
        }
        if (abort.current === controller) abort.current = null;
      }
    },
    [client, noteId],
  );

  const send = useCallback(
    async (request: AssistantInput) => {
      if (phase !== "idle") return;
      const content = request.action === "ask" ? (request.question ?? "") : ASSISTANT_ACTION_INFO[request.action].defaultMessage;
      // Show the request immediately and remember it, so a failure never loses it.
      setMessages((prev) => [
        ...prev,
        {
          id: `tmp-${++tempCounter}`,
          conversationId: "",
          role: "user",
          content,
          mode: null,
          action: request.action,
          model: null,
          isMock: false,
          createdAt: new Date().toISOString(),
        },
      ]);
      last.current = { input: request, saved: false };
      await run({ kind: "ask", request });
    },
    [phase, run],
  );

  const regenerate = useCallback(async () => {
    if (phase !== "idle") return;
    await run({ kind: "regenerate" });
  }, [phase, run]);

  const retry = useCallback(async () => {
    const pending = last.current;
    if (pending && !pending.saved) {
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("tmp-")));
      await send(pending.input);
      return;
    }
    await regenerate();
  }, [regenerate, send]);

  const stop = useCallback(() => {
    stopRequested.current = true;
    abort.current?.abort();
  }, []);

  const visible = useMemo(() => {
    if (!(regenerating && streamingText !== null)) return messages;
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    return lastAssistant === messages.length - 1 ? messages.slice(0, -1) : messages;
  }, [messages, regenerating, streamingText]);

  return {
    messages: visible,
    streamingText,
    phase,
    error,
    loadError,
    isBusy: phase === "streaming",
    send,
    retry,
    regenerate,
    stop,
    reload: load,
    dismissError: () => setError(null),
  };
}
