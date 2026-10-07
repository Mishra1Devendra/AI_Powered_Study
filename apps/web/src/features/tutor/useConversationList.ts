import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "@copilot/shared";
import { deleteConversation, listConversations } from "../../lib/tutorApi";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; conversations: Conversation[] };

/** The student's conversation history. Loaded once; kept in sync locally (no refetch per message). */
export function useConversationList(client: SupabaseClient) {
  const [state, setState] = useState<State>({ status: "loading" });
  const requested = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", conversations: await listConversations(client) });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load your conversations." });
    }
  }, [client]);

  useEffect(() => {
    if (requested.current) return; // StrictMode double-mount: one request only
    requested.current = true;
    void load();
  }, [load]);

  /** Insert or update a conversation and keep the list ordered by most recent activity. */
  const upsert = useCallback((conversation: Conversation) => {
    setState((s) => {
      if (s.status !== "ready") return s;
      const rest = s.conversations.filter((c) => c.id !== conversation.id);
      return { status: "ready", conversations: [conversation, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
    });
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteConversation(client, id);
      setState((s) => (s.status === "ready" ? { status: "ready", conversations: s.conversations.filter((c) => c.id !== id) } : s));
    },
    [client],
  );

  return { state, reload: load, upsert, remove };
}
