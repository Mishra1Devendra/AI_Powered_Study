import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cardResponseSchema,
  deckDetailResponseSchema,
  deckListResponseSchema,
  deckResponseSchema,
  mindmapListResponseSchema,
  mindmapResponseSchema,
  reviewResponseSchema,
  studyQueueResponseSchema,
  type CardGrade,
  type CardInput,
  type Deck,
  type DeckDetailResponse,
  type DeckListResponse,
  type Flashcard,
  type GenerateDeckInput,
  type GenerateMindmapInput,
  type Mindmap,
  type StudyQueueResponse,
  type UpdateCardInput,
} from "@copilot/shared";
import { z } from "zod";
import { request } from "./api";

const FC = "/api/flashcards";
const MM = "/api/mindmaps";
const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const none = z.null();

/** DELETE answers 204 with no body; `request` reads JSON, so an empty body is read as null. */
async function remove(client: SupabaseClient, path: string): Promise<void> {
  await request(client, path, none, send("DELETE"));
}

/* ------------------------------------------------ flashcards ------------------------------------------------ */

export const listDecks = (client: SupabaseClient): Promise<DeckListResponse> => request(client, `${FC}/decks`, deckListResponseSchema);

/** Starts writing a deck. Returns at once with status "generating"; poll `getDeck` until it is ready. */
export async function generateDeck(client: SupabaseClient, input: GenerateDeckInput): Promise<Deck> {
  return (await request(client, `${FC}/decks/generate`, deckResponseSchema, send("POST", input))).deck;
}
export async function createDeck(client: SupabaseClient, title: string): Promise<Deck> {
  return (await request(client, `${FC}/decks`, deckResponseSchema, send("POST", { title }))).deck;
}
export const getDeck = (client: SupabaseClient, id: string): Promise<DeckDetailResponse> => request(client, `${FC}/decks/${id}`, deckDetailResponseSchema);
export async function renameDeck(client: SupabaseClient, id: string, title: string): Promise<Deck> {
  return (await request(client, `${FC}/decks/${id}`, deckResponseSchema, send("PATCH", { title }))).deck;
}
export const deleteDeck = (client: SupabaseClient, id: string) => remove(client, `${FC}/decks/${id}`);

export async function addCard(client: SupabaseClient, deckId: string, input: CardInput): Promise<Flashcard> {
  return (await request(client, `${FC}/decks/${deckId}/cards`, cardResponseSchema, send("POST", input))).card;
}
export async function updateCard(client: SupabaseClient, id: string, input: UpdateCardInput): Promise<Flashcard> {
  return (await request(client, `${FC}/cards/${id}`, cardResponseSchema, send("PATCH", input))).card;
}
export const deleteCard = (client: SupabaseClient, id: string) => remove(client, `${FC}/cards/${id}`);

export const getStudyQueue = (client: SupabaseClient, deckId: string): Promise<StudyQueueResponse> => request(client, `${FC}/decks/${deckId}/study`, studyQueueResponseSchema);
/** The server decides when the card comes back; this only says how well it was remembered. */
export async function reviewCard(client: SupabaseClient, id: string, grade: CardGrade): Promise<Flashcard> {
  return (await request(client, `${FC}/cards/${id}/review`, reviewResponseSchema, send("POST", { grade }))).card;
}

/* ------------------------------------------------ mind maps ------------------------------------------------ */

export async function generateMindmap(client: SupabaseClient, input: GenerateMindmapInput): Promise<Mindmap> {
  return (await request(client, `${MM}/generate`, mindmapResponseSchema, send("POST", input))).mindmap;
}
export async function listMindmaps(client: SupabaseClient): Promise<Mindmap[]> {
  return (await request(client, MM, mindmapListResponseSchema)).mindmaps;
}
export async function getMindmap(client: SupabaseClient, id: string): Promise<Mindmap> {
  return (await request(client, `${MM}/${id}`, mindmapResponseSchema)).mindmap;
}
export async function renameMindmap(client: SupabaseClient, id: string, title: string): Promise<Mindmap> {
  return (await request(client, `${MM}/${id}`, mindmapResponseSchema, send("PATCH", { title }))).mindmap;
}
export const deleteMindmap = (client: SupabaseClient, id: string) => remove(client, `${MM}/${id}`);
export async function regenerateMindmap(client: SupabaseClient, id: string): Promise<Mindmap> {
  return (await request(client, `${MM}/${id}/regenerate`, mindmapResponseSchema, send("POST"))).mindmap;
}
