import { STUDY_TOOLS_LIMITS, type MindmapNode, type MindmapSize, type Note, type StudySource } from "@copilot/shared";
import type { NotesRepository } from "../notes/repository.js";
import { pickPassages } from "../quiz/generate.js";
import { AIError, type LLMProvider } from "../services/ai/index.js";
import type { ChatMessage, GenerateTextResult } from "../services/ai/types.js";
import { buildFlashcardPrompt, buildMindmapPrompt, type StudyScope } from "../services/ai/study-tools/prompt.js";
import { parseCards, parseMindmap, type ParsedCard } from "./parse.js";

/** A failure with a message that is safe to show the student. */
export class StudyGenerationError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "StudyGenerationError";
  }
}

export interface StudyGenerationDeps {
  ai: LLMProvider;
  notes: NotesRepository;
  rng?: () => number;
  signal?: AbortSignal;
}

/** A local model on a modest CPU can need minutes for one structured answer; the service also enforces its own overall deadline. */
export const STUDY_CALL_TIMEOUT_MS = 10 * 60_000;
/** Too little text and the cards or branches would be invented rather than taken from the notes. */
const MIN_MATERIAL_CHARS = 200;

export interface Material {
  scope: StudyScope;
  /** Suggested title for the result. */
  title: string;
}

/** Loads the student's own notes (never anyone else's) or builds the topic scope. Everything checkable locally is checked before the AI is called. */
export async function resolveMaterial(deps: StudyGenerationDeps, userId: string, source: StudySource): Promise<Material> {
  if (source.type === "topic") {
    const subject = source.subject.trim();
    const topic = source.topic?.trim() || null;
    return { scope: { grounded: false, subject, topic, passages: [] }, title: topic ? `${subject}: ${topic}` : subject };
  }
  const docs: Note[] = [];
  for (const id of source.documentIds) {
    const doc = await deps.notes.getNote(userId, id);
    if (!doc || doc.status !== "ready") throw new StudyGenerationError("One of the selected notes is not available or is not ready yet.", false);
    docs.push(doc);
  }
  const passages = await pickPassages(deps.notes, userId, docs, source.focus?.trim() || null, deps.rng ?? Math.random);
  const chars = passages.reduce((n, p) => n + p.content.length, 0);
  if (passages.length === 0 || chars < MIN_MATERIAL_CHARS) {
    throw new StudyGenerationError("There isn't enough text in the selected notes (or matching your focus) to work from.", false);
  }
  const names = docs.map((d) => d.title);
  const title = names.length === 1 ? names[0]! : `${names[0]} + ${names.length - 1} more`;
  return { scope: { grounded: true, subject: null, topic: null, passages }, title };
}

async function callAi(deps: StudyGenerationDeps, request: { system: string; messages: ChatMessage[] }, maxTokens: number): Promise<GenerateTextResult> {
  try {
    // ONE model call per request the student made. No retry loop: if the answer is unusable the student is told and may press the button again.
    return await deps.ai.generateText({
      system: request.system,
      messages: request.messages,
      json: true,
      timeoutMs: STUDY_CALL_TIMEOUT_MS,
      temperature: 0.4,
      maxTokens,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    if (deps.signal?.aborted) throw new StudyGenerationError("This took too long. Please try again.");
    if (err instanceof AIError) throw new StudyGenerationError(err.message, err.retryable);
    throw err;
  }
}

const UNREADABLE = "The AI's answer couldn't be read. Please try again.";

export interface GeneratedCards {
  cards: ParsedCard[];
  title: string;
  provider: string;
  model: string;
  isMock: boolean;
}

export async function generateFlashcards(deps: StudyGenerationDeps, userId: string, source: StudySource, count: number): Promise<GeneratedCards> {
  const material = await resolveMaterial(deps, userId, source);
  const prompt = buildFlashcardPrompt({ ...material.scope, count });
  const result = await callAi(deps, prompt, Math.min(4_000, 120 * count + 300));
  const cards = parseCards(result.text, count);
  // A few cards are a usable deck; fewer than that means the answer was not really a set of cards.
  if (cards.length < Math.min(3, count)) throw new StudyGenerationError(UNREADABLE);
  return { cards, title: material.title, provider: result.provider, model: result.model, isMock: result.isMock };
}

export interface GeneratedMap {
  tree: MindmapNode;
  nodeCount: number;
  title: string;
  provider: string;
  model: string;
  isMock: boolean;
}

export async function generateMindmap(deps: StudyGenerationDeps, userId: string, source: StudySource, size: MindmapSize, titleOverride?: string): Promise<GeneratedMap> {
  const material = await resolveMaterial(deps, userId, source);
  const baseTitle = (titleOverride?.trim() || material.title).slice(0, STUDY_TOOLS_LIMITS.titleMaxChars);
  const prompt = buildMindmapPrompt({ ...material.scope, size, title: baseTitle });
  const result = await callAi(deps, prompt, 3_000);
  const map = parseMindmap(result.text, baseTitle);
  if (!map) throw new StudyGenerationError(UNREADABLE);
  return { tree: map.tree, nodeCount: map.nodeCount, title: titleOverride?.trim() ? baseTitle : (map.title ?? baseTitle).slice(0, STUDY_TOOLS_LIMITS.titleMaxChars), provider: result.provider, model: result.model, isMock: result.isMock };
}
