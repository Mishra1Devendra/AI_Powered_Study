import type { Difficulty, GeneratableQuestionType, Note } from "@copilot/shared";
import { extractKeywords } from "../notes/retrieval.js";
import type { ChunkHit, NotesRepository } from "../notes/repository.js";
import { AIError, type LLMProvider } from "../services/ai/index.js";
import { buildQuizPrompt, wantedTotal } from "../services/ai/quiz/prompt.js";
import type { PromptSource } from "../services/ai/notes/prompt.js";
import type { NewQuestion, SourceRefStored } from "./repository.js";
import { REJECTION_LABEL, checkQuality, locateEvidence, type QualityContext } from "./quality.js";
import { parseQuestionsJson, shuffleOptions, shuffled, validateQuestions, type ValidQuestion } from "./validate.js";

/** A failure with a message that is safe to show the student. */
export class QuizGenerationError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "QuizGenerationError";
  }
}

export interface GenerationConfig {
  sourceType: "notes" | "topic";
  subject: string | null;
  topic: string | null;
  focus: string | null;
  difficulty: Difficulty;
  count: number;
  types: GeneratableQuestionType[];
  documentIds: string[];
}

/** What the job is doing right now, reported as it happens (never an estimate). */
export type GenerationStage = "preparing" | "generating" | "checking" | "finalizing";

export interface GenerationProgress {
  stage: GenerationStage;
  /** Which model call is running (1-based), 0 before the first. */
  batch: number;
  /** Questions that have passed every check so far. */
  accepted: number;
  target: number;
}

export interface GenerationDeps {
  ai: LLMProvider;
  onProgress?: (p: GenerationProgress) => void;
  notes: NotesRepository;
  rng?: () => number;
  signal?: AbortSignal;
}

export interface GenerationResult {
  questions: NewQuestion[];
  provider: string;
  model: string;
  isMock: boolean;
}

/** Questions requested per model call: small enough for a local model to finish quickly and reliably. */
export const BATCH_SIZE = 5;
/** Passages sent per call. Kept small on purpose: local models are slow and long prompts hurt quality. */
const MAX_PASSAGES = 8;
const CONTEXT_BUDGET_CHARS = 6_000;
/** A quiz needs enough material to ask about; otherwise questions repeat or get invented. */
const MIN_MATERIAL_CHARS_PER_QUESTION = 120;
const MAX_TOPICS = 12;
/**
 * A batch of questions is a long structured answer; on a modest CPU a local model needs minutes for
 * it (measured: ~5 minutes for 5 questions on a machine with little free RAM). The tutor's shorter
 * default would cut it off, so quiz calls get their own, more generous limit.
 */
export const QUIZ_CALL_TIMEOUT_MS = 15 * 60_000;
/** First attempt is focused; each retry is a little looser so the model does not repeat the same rejected answer. */
/** Extra model calls allowed beyond one per batch of five, to replace questions that failed the checks. */
const EXTRA_CALLS = 2;
/** Stop early after this many calls in a row that produced nothing usable. */
const MAX_BARREN_CALLS = 2;
export const TEMPERATURES = [0.3, 0.6, 0.8, 0.9] as const;

interface Passage extends PromptSource {
  ref: SourceRefStored;
}

/** `k` distinct indexes spread over [0, total): one random pick per equal-width bucket. */
export function stratifiedIndexes(total: number, k: number, rng: () => number): number[] {
  if (total <= 0 || k <= 0) return [];
  if (k >= total) return Array.from({ length: total }, (_, i) => i);
  const width = total / k;
  return [...new Set(Array.from({ length: k }, (_, i) => Math.min(total - 1, Math.floor(i * width + rng() * width))))];
}

/** Picks passages from the student's ready notes: matches for the focus text first, then a spread over the whole note. */
export async function pickPassages(
  notes: NotesRepository,
  userId: string,
  docs: readonly Note[],
  focus: string | null,
  rng: () => number,
): Promise<Passage[]> {
  const perDoc = Math.max(2, Math.ceil(MAX_PASSAGES / docs.length));
  const keywords = focus ? extractKeywords(focus) : [];
  const hits: Array<ChunkHit & { documentId: string }> = [];
  for (const doc of docs) {
    const seen = new Set<number>();
    const add = (list: ChunkHit[]) => {
      for (const h of list) {
        if (seen.size >= perDoc) break;
        if (!seen.has(h.chunkIndex)) (seen.add(h.chunkIndex), hits.push({ ...h, documentId: doc.id }));
      }
    };
    if (keywords.length > 0) add(await notes.searchChunks(userId, doc.id, keywords, perDoc));
    if (seen.size < perDoc) add(await notes.getChunks(userId, doc.id, stratifiedIndexes(doc.chunkCount, perDoc, rng).filter((i) => !seen.has(i))));
  }

  // Budget: keep document order, drop what does not fit (always keep at least one).
  const chosen: typeof hits = [];
  let used = 0;
  for (const h of hits) {
    if (chosen.length >= MAX_PASSAGES) break;
    if (chosen.length > 0 && used + h.content.length > CONTEXT_BUDGET_CHARS) continue;
    chosen.push(h);
    used += h.content.length;
  }
  return chosen.map((h, i) => ({
    key: `S${i + 1}`,
    page: h.page,
    heading: h.heading,
    content: h.content,
    ref: { documentId: h.documentId, chunkIndex: h.chunkIndex, page: h.page, heading: h.heading },
  }));
}

/** Splits the total across the chosen types as evenly as possible (extras go to the first types). */
export function splitByType(count: number, types: readonly GeneratableQuestionType[]): Partial<Record<GeneratableQuestionType, number>> {
  const out: Partial<Record<GeneratableQuestionType, number>> = {};
  types.forEach((t, i) => {
    out[t] = Math.floor(count / types.length) + (i < count % types.length ? 1 : 0);
  });
  return out;
}

/** Up to `size` questions for one call, drawn from what is still missing, mixing types. */
export function nextBatch(remaining: Partial<Record<GeneratableQuestionType, number>>, size: number): Partial<Record<GeneratableQuestionType, number>> {
  const out: Partial<Record<GeneratableQuestionType, number>> = {};
  let left = size;
  const types = Object.keys(remaining) as GeneratableQuestionType[];
  while (left > 0) {
    let progressed = false;
    for (const t of types) {
      if (left > 0 && (remaining[t] ?? 0) - (out[t] ?? 0) > 0) {
        out[t] = (out[t] ?? 0) + 1;
        left--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export async function generateQuestions(deps: GenerationDeps, userId: string, config: GenerationConfig, avoid: string[]): Promise<GenerationResult> {
  const { ai, notes, signal } = deps;
  const rng = deps.rng ?? Math.random;
  const accepted: ValidQuestion[] = [];
  const report = (stage: GenerationStage, batch = 0) => deps.onProgress?.({ stage, batch, accepted: accepted.length, target: config.count });

  // 1) Source material (notes quizzes only). Everything that can be checked locally is checked
  //    BEFORE the slow model is called.
  report("preparing");
  let passages: Passage[] = [];
  if (config.sourceType === "notes") {
    const docs: Note[] = [];
    for (const id of config.documentIds) {
      const doc = await notes.getNote(userId, id); // RLS: only this student's notes
      if (!doc || doc.status !== "ready") throw new QuizGenerationError("One of the selected notes is not available or is not ready yet.", false);
      docs.push(doc);
    }
    passages = await pickPassages(notes, userId, docs, config.focus, rng);
    const chars = passages.reduce((n, p) => n + p.content.length, 0);
    if (passages.length === 0 || chars < MIN_MATERIAL_CHARS_PER_QUESTION * config.count) {
      throw new QuizGenerationError(
        passages.length === 0 || chars < MIN_MATERIAL_CHARS_PER_QUESTION
          ? "There isn't enough text in the selected notes (or matching your focus) to make a quiz."
          : `There isn't enough material for ${config.count} questions. Try fewer questions, add more notes, or remove the focus.`,
        false,
      );
    }
  }
  const headings = [...new Set(passages.map((p) => p.heading).filter((h): h is string => Boolean(h)))].slice(0, MAX_TOPICS);

  // 2) Generate in small batches. Every question must pass the structural checks AND the quality gate.
  //    The number of model calls is small and bounded, and generation stops early if the model is
  //    clearly not producing usable questions (it is slow; repeating a failing request wastes time).
  const remaining = splitByType(config.count, config.types);
  const rejections = new Map<string, number>();
  const tally = (code: string) => rejections.set(code, (rejections.get(code) ?? 0) + 1);
  let isMock = false;
  let model = ai.model;
  let provider: string = ai.name;
  let barren = 0; // consecutive calls that produced nothing usable
  const maxCalls = Math.ceil(config.count / BATCH_SIZE) + EXTRA_CALLS;

  for (let call = 0; call < maxCalls && accepted.length < config.count && barren < MAX_BARREN_CALLS; call++) {
    const want = nextBatch(remaining, BATCH_SIZE);
    if (wantedTotal(want) === 0) break;
    // A top-up for a single question is asked for two: extras beyond what is still needed are simply ignored,
    // and a spare gives the model a second chance at a valid, non-duplicate question.
    if (call > 0 && wantedTotal(want) < 2) {
      const t = (Object.keys(want) as GeneratableQuestionType[])[0]!;
      want[t] = (want[t] ?? 0) + 1;
    }
    const n = wantedTotal(want);
    const prompt = buildQuizPrompt({
      sourceType: config.sourceType,
      subject: config.subject,
      topic: config.topic,
      difficulty: config.difficulty,
      want,
      passages,
      topics: headings,
      avoid: [...avoid, ...accepted.map((q) => q.text)].slice(-30),
      offset: avoid.length + accepted.length,
    });
    report("generating", call + 1);
    let result;
    try {
      result = await ai.generateText({
        system: prompt.system,
        messages: prompt.messages,
        json: true,
        timeoutMs: QUIZ_CALL_TIMEOUT_MS,
        temperature: TEMPERATURES[Math.min(call, TEMPERATURES.length - 1)]!,
        // With the supporting quote, a question takes ~350 tokens on llama3.2:3b; leave room so a batch is not cut off.
        maxTokens: Math.min(4_000, 450 * n + 300),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new QuizGenerationError("Creating the quiz took too long. Try fewer questions.");
      if (err instanceof AIError) throw new QuizGenerationError(err.message, err.retryable);
      throw err;
    }
    provider = result.provider;
    model = result.model;
    isMock ||= result.isMock;

    report("checking", call + 1);
    const raw = parseQuestionsJson(result.text);
    if (!raw) {
      tally("structure");
      barren++;
      continue; // unusable JSON: bounded by maxCalls and MAX_BARREN_CALLS
    }
    // Source checks apply to a real model's notes quiz. The demo provider's placeholder text is not
    // about the notes, so only the structural and wording checks apply to it.
    const gate: QualityContext = {
      passages: passages.map((p) => ({ key: p.key, content: p.content })),
      grounded: config.sourceType === "notes" && !result.isMock,
    };
    const { accepted: good, rejected } = validateQuestions(raw, {
      remaining,
      difficulty: config.difficulty,
      allowedTopics: headings,
      sourceKeys: passages.map((p) => p.key),
      existing: [...avoid, ...accepted.map((q) => q.text)],
      quality: (q) => checkQuality(q, gate),
    });
    for (const r of rejected) if (!/more (mcq|true_false) questions than requested/.test(r.reason)) tally(r.code);
    for (const q of good) {
      accepted.push(q);
      remaining[q.type] = (remaining[q.type] ?? 0) - 1;
    }
    barren = good.length === 0 ? barren + 1 : 0;
  }

  if (accepted.length < config.count) {
    const problems = [...rejections]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([code, count]) => `${REJECTION_LABEL[code] ?? code} (${count})`);
    throw new QuizGenerationError(
      `The AI only produced ${accepted.length} acceptable question${accepted.length === 1 ? "" : "s"} out of ${config.count}${problems.length ? `; the most common problems were ${problems.join(" and ")}` : ""}. Nothing was saved. Please try again, or ask for fewer questions.`,
    );
  }

  // 3) Final shape: shuffle answer positions and question order, attach real topics and source references.
  const fallbackTopic = config.sourceType === "topic" ? (config.topic ?? config.subject) : null;
  const questions: NewQuestion[] = shuffled(accepted.slice(0, config.count), rng)
    .map((q) => shuffleOptions(q, rng))
    .map((q, order) => {
      // The passage the question really came from: the one containing its quote, else the one it cited.
      const located = q.evidence ? locateEvidence(q.evidence, passages, q.sourceKey) : null;
      const passage = (located && passages.find((p) => p.key === located.key)) ?? (q.sourceKey ? passages.find((p) => p.key === q.sourceKey) : undefined);
      return {
        order,
        type: q.type,
        text: q.text,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
        // Never invented: the model's label if it was one of the real section titles, else the cited
        // passage's own heading, else (topic quizzes) what the student typed, else unclassified.
        topic: q.topic ?? passage?.heading?.slice(0, 100) ?? fallbackTopic?.slice(0, 100) ?? null,
        difficulty: q.difficulty,
        // The quote is kept only when it was verified to be in the notes.
        sourceRef: passage ? { ...passage.ref, evidence: located ? q.evidence : null } : null,
      };
    });
  return { questions, provider, model, isMock };
}
