import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attemptListResponseSchema,
  attemptViewSchema,
  generateQuizResponseSchema,
  quizDetailResponseSchema,
  quizListResponseSchema,
  quizOptionsSchema,
  resultSchema,
  type AttemptView,
  type GenerateQuizInput,
  type Quiz,
  type QuizOptions,
  type QuizResult,
  type SaveAnswersInput,
} from "@copilot/shared";
import { z } from "zod";
import { request } from "./api";

const BASE = "/api/quiz";
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const getQuizOptions = (client: SupabaseClient): Promise<QuizOptions> => request(client, `${BASE}/options`, quizOptionsSchema);

/** Starts generating a quiz. Returns at once with status "generating"; poll `getQuiz` until it is ready. */
export async function generateQuiz(client: SupabaseClient, input: GenerateQuizInput): Promise<Quiz> {
  return (await request(client, `${BASE}/generate`, generateQuizResponseSchema, post(input))).quiz;
}

export const listQuizzes = (client: SupabaseClient) => request(client, BASE, quizListResponseSchema);
export const listAttempts = async (client: SupabaseClient) => (await request(client, `${BASE}/attempts`, attemptListResponseSchema)).attempts;
export const getQuiz = (client: SupabaseClient, id: string) => request(client, `${BASE}/${id}`, quizDetailResponseSchema);

export const startQuiz = (client: SupabaseClient, id: string): Promise<AttemptView> => request(client, `${BASE}/${id}/start`, attemptViewSchema, post());
/** A new attempt on the same questions in a new order (earlier attempts are kept). */
export const retryQuiz = (client: SupabaseClient, id: string): Promise<AttemptView> => request(client, `${BASE}/${id}/retry`, attemptViewSchema, post());
/** A brand-new quiz with the same settings and sources, but different questions. */
export async function regenerateQuiz(client: SupabaseClient, id: string): Promise<Quiz> {
  return (await request(client, `${BASE}/${id}/regenerate`, generateQuizResponseSchema, post())).quiz;
}

export const getAttempt = (client: SupabaseClient, id: string): Promise<AttemptView> => request(client, `${BASE}/attempts/${id}`, attemptViewSchema);

export const saveAnswers = (client: SupabaseClient, id: string, input: SaveAnswersInput) =>
  request(client, `${BASE}/attempts/${id}/answers`, z.object({ saved: z.number() }), { method: "PUT", body: JSON.stringify(input) });

/** The score is calculated by the server; the answers sent here are only the student's choices. */
export const submitAttempt = (client: SupabaseClient, id: string, input: SaveAnswersInput): Promise<QuizResult> =>
  request(client, `${BASE}/attempts/${id}/submit`, resultSchema, post(input));

export const getResult = (client: SupabaseClient, id: string): Promise<QuizResult> => request(client, `${BASE}/attempts/${id}/result`, resultSchema);
