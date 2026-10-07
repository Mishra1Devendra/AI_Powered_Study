import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeckDetailResponse, DeckListResponse, Mindmap } from "@copilot/shared";
import { getDeck, getMindmap, listDecks, listMindmaps } from "../../lib/studyToolsApi";
import { useLoad } from "../quiz/useQuizData";

const POLL_MS = 3000;

/** Your decks. Refreshes by itself while one is still being written. */
export function useDecks(client: SupabaseClient) {
  return useLoad<DeckListResponse>(() => listDecks(client), [client], (d) => d.decks.some((x) => x.status === "generating"), POLL_MS);
}

/** One deck with its cards. Polls while it is being written so the page flips to "ready" on its own. */
export function useDeck(client: SupabaseClient, deckId: string) {
  return useLoad<DeckDetailResponse>(() => getDeck(client, deckId), [client, deckId], (d) => d.deck.status === "generating", POLL_MS);
}

export function useMindmaps(client: SupabaseClient) {
  return useLoad<Mindmap[]>(() => listMindmaps(client), [client], (list) => list.some((m) => m.status === "generating"), POLL_MS);
}

export function useMindmap(client: SupabaseClient, id: string) {
  return useLoad<Mindmap>(() => getMindmap(client, id), [client, id], (m) => m.status === "generating", POLL_MS);
}
