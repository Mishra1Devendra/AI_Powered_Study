import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, TutorContextInput, TutorMessage, TutorMode } from "@copilot/shared";
import { ApiError } from "../../lib/api";
import {
  createConversation,
  getConversation,
  streamTutorReply,
  updateConversation,
} from "../../lib/tutorApi";

export interface ChatError {
  code: string;
  message: string;
  retryable: boolean;
  /** The session expired: the only useful action is signing in again. */
  reauth?: boolean;
}

type Phase = "idle" | "loading" | "streaming";

interface Options {
  client: SupabaseClient;
  /** Conversation id from the URL (`/tutor/:conversationId`), if any. */
  routeId: string | undefined;
  /** A conversation was created or changed (title, context, new activity). */
  onConversation: (conversation: Conversation) => void;
  /** A brand-new conversation was created locally: reflect it in the URL. */
  onCreated: (conversation: Conversation) => void;
  /** Phase 11: ask about ONE of the student's documents ("Ask AI about this"). The server checks it is theirs. */
  documentId?: string | null;
}

/** Regenerated replies supersede the previous assistant reply (same rule as the server). */
function collapse(messages: TutorMessage[]): TutorMessage[] {
  const out: TutorMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") out[out.length - 1] = m;
    else out.push(m);
  }
  return out;
}

function toChatError(err: unknown): ChatError {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return { code: "auth", message: "Your session has expired. Please sign in again.", retryable: false, reauth: true };
    }
    if (err.status === 404) return { code: "not_found", message: "This conversation no longer exists.", retryable: false };
    if (err.status === 0) return { code: "network", message: err.message, retryable: true };
    return { code: `http_${err.status}`, message: err.message, retryable: err.status === 429 || err.status >= 500 || err.status === 409 };
  }
  return { code: "unknown", message: "Something went wrong. Please try again.", retryable: true };
}

let tempCounter = 0;

export function useTutorChat({ client, routeId, onConversation, onCreated, documentId = null }: Options) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ChatError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftContext, setDraftContext] = useState<TutorContextInput>({});

  const activeIdRef = useRef<string | null>(null);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const lastSendRef = useRef<{ content: string; mode: TutorMode | null; saved: boolean; general: boolean } | null>(null);
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  // Always-current copies for callbacks (avoids stale closures without re-creating them).
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const draftRef = useRef(draftContext);
  draftRef.current = draftContext;
  const callbacks = useRef({ onConversation, onCreated });
  callbacks.current = { onConversation, onCreated };

  const cancelInFlight = useCallback(() => {
    epochRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const resetState = useCallback(() => {
    setConversation(null);
    setMessages([]);
    setStreamingText(null);
    setRegenerating(false);
    setError(null);
    setLoadError(null);
    setPhase("idle");
    lastSendRef.current = null;
  }, []);

  const load = useCallback(
    async (id: string) => {
      const epoch = ++epochRef.current;
      activeIdRef.current = id;
      resetState();
      setPhase("loading");
      try {
        const detail = await getConversation(client, id);
        if (epochRef.current !== epoch) return;
        setConversation(detail.conversation);
        setMessages(detail.messages);
        setPhase("idle");
      } catch (err) {
        if (epochRef.current !== epoch) return;
        const e = toChatError(err);
        setLoadError(e.code === "not_found" ? "This conversation doesn't exist or was deleted." : e.message);
        setPhase("idle");
      }
    },
    [client, resetState],
  );

  // Follow the URL. A conversation we just created locally is already on screen: don't reload it.
  useEffect(() => {
    if (!routeId) {
      if (activeIdRef.current !== null) {
        cancelInFlight();
        activeIdRef.current = null;
        resetState();
      }
      return;
    }
    if (activeIdRef.current === routeId) return;
    cancelInFlight();
    void load(routeId);
  }, [routeId, load, cancelInFlight, resetState]);

  // Abort anything in flight when leaving the page. Resetting the active id also makes React
  // StrictMode's dev double-mount reload correctly.
  useEffect(
    () => () => {
      cancelInFlight();
      activeIdRef.current = null;
    },
    [cancelInFlight],
  );

  /** Streams a reply for `id` and folds the events into state. Never throws. */
  const runStream = useCallback(
    async (id: string, input: Parameters<typeof streamTutorReply>[2], isRegenerate: boolean) => {
      const epoch = epochRef.current;
      const alive = () => epochRef.current === epoch;
      const controller = new AbortController();
      abortRef.current = controller;
      stopRequestedRef.current = false;

      setPhase("streaming");
      setStreamingText("");
      setRegenerating(isRegenerate);
      setError(null);

      // Batch token updates to one render per animation frame instead of one per chunk.
      let buffer = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (alive()) setStreamingText(buffer);
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(flush);
      };

      let finished = false;
      let failed = false;
      try {
        for await (const event of streamTutorReply(client, id, input, controller.signal)) {
          if (!alive()) return;
          switch (event.type) {
            case "user_message": {
              if (lastSendRef.current) lastSendRef.current.saved = true;
              setMessages((prev) => {
                const withoutTemp = prev.filter((m) => !m.id.startsWith("tmp-"));
                return [...withoutTemp, event.message];
              });
              break;
            }
            case "delta":
              buffer += event.text;
              schedule();
              break;
            case "done":
              finished = true;
              if (frame) cancelAnimationFrame(frame);
              setMessages((prev) => collapse([...prev, event.message]));
              setConversation(event.conversation);
              callbacks.current.onConversation(event.conversation);
              break;
            case "error":
              failed = true;
              setError({ code: event.code, message: event.message, retryable: event.retryable });
              break;
          }
        }
        if (alive() && !finished && !failed) {
          if (stopRequestedRef.current) {
            setError({ code: "stopped", message: "Response stopped.", retryable: true });
          } else {
            setError({ code: "interrupted", message: "The connection ended before the tutor finished answering.", retryable: true });
          }
        }
      } catch (err) {
        if (alive()) setError(toChatError(err));
      } finally {
        if (frame) cancelAnimationFrame(frame);
        if (alive()) {
          setStreamingText(null);
          setRegenerating(false);
          setPhase("idle");
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [client],
  );

  const send = useCallback(
    async (content: string, mode: TutorMode | null = null, opts: { general?: boolean } = {}) => {
      if (phase !== "idle") return;
      const general = opts.general === true;
      setError(null);
      // Show the message immediately and remember it, so if anything fails (even creating the
      // conversation) it is never lost and Retry can send it again.
      const temp: TutorMessage = {
        id: `tmp-${++tempCounter}`,
        conversationId: conversationRef.current?.id ?? "",
        role: "user",
        content,
        mode,
        model: null,
        isMock: false,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, temp]);
      lastSendRef.current = { content, mode, saved: false, general };

      let current = conversationRef.current;
      if (!current) {
        try {
          current = await createConversation(client, draftRef.current);
        } catch (err) {
          setError(toChatError(err));
          return;
        }
        activeIdRef.current = current.id;
        setConversation(current);
        callbacks.current.onCreated(current);
      }
      await runStream(
        current.id,
        { kind: "send", message: { content, ...(mode ? { mode } : {}), ...(documentIdRef.current ? { documentId: documentIdRef.current } : {}), ...(general ? { grounding: "general" as const } : {}) } },
        false,
      );
    },
    [client, phase, runStream],
  );

  /** Re-asks the tutor to answer the latest student message (after an error, or "Regenerate"). */
  const regenerate = useCallback(async () => {
    const current = conversationRef.current;
    if (!current || phase !== "idle") return;
    await runStream(current.id, { kind: "regenerate" }, true);
  }, [phase, runStream]);

  const retry = useCallback(async () => {
    const pending = lastSendRef.current;
    if (pending && !pending.saved) {
      // The student's message never reached the server: send it again rather than regenerate.
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("tmp-")));
      await send(pending.content, pending.mode, { general: pending.general });
      return;
    }
    await regenerate();
  }, [regenerate, send]);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const setContext = useCallback(
    async (ctx: TutorContextInput) => {
      const current = conversationRef.current;
      if (!current) {
        setDraftContext((d) => ({ ...d, ...ctx }));
        return;
      }
      try {
        const updated = await updateConversation(client, current.id, ctx);
        setConversation(updated);
        callbacks.current.onConversation(updated);
      } catch (err) {
        setError(toChatError(err));
      }
    },
    [client],
  );

  // While regenerating, the superseded reply is hidden so two answers never show at once.
  const visibleMessages = useMemo(() => {
    if (!(regenerating && streamingText !== null)) return messages;
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    return lastAssistant === messages.length - 1 ? messages.slice(0, -1) : messages;
  }, [messages, regenerating, streamingText]);

  return {
    conversation,
    messages: visibleMessages,
    streamingText,
    phase,
    error,
    loadError,
    draftContext,
    isBusy: phase !== "idle",
    send,
    retry,
    regenerate,
    stop,
    setContext,
    reload: () => (routeId ? load(routeId) : undefined),
    dismissError: () => setError(null),
  };
}
