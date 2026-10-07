import { AIError, type LLMProvider } from "../services/ai/index.js";
import { buildEvaluationPrompt, buildQuestionPrompt, type EvaluationPromptInput, type QuestionPromptInput } from "../services/ai/viva/prompt.js";
import { parsePlanJson as parseJsonObject } from "../planner/topics.js";
import { validateEvaluation, validateQuestion, VivaInvalid, type ValidEvaluation, type ValidQuestion } from "./validate.js";

/** A failure whose message is safe to show the student. */
export class VivaAiError extends Error {
  constructor(
    message: string,
    readonly code: "examiner_timeout" | "examiner_unreadable" | "examiner_unavailable",
  ) {
    super(message);
    this.name = "VivaAiError";
  }
}

/** A local model on a modest CPU can take a while for even a short structured answer. */
export const VIVA_CALL_TIMEOUT_MS = 4 * 60_000;
/**
 * The most model calls ONE step (a question, or an evaluation) may make: the first try plus a single retry, and only
 * when the first reply was unreadable or failed validation. Provider errors (timeout, unavailable) are never retried.
 */
export const MAX_CALLS_PER_STEP = 2;

const TIMEOUT_MESSAGE = "The examiner took too long to respond. Please try again.";
const UNREADABLE_MESSAGE = "The examiner's reply could not be read. Nothing was saved. Please try again.";

export interface Produced {
  model: string;
  isMock: boolean;
}

async function step<T>(
  ai: LLMProvider,
  signal: AbortSignal | undefined,
  prompt: { system: string; messages: Parameters<LLMProvider["generateText"]>[0]["messages"] },
  options: { temperature: number; maxTokens: number },
  check: (raw: unknown) => T,
): Promise<{ value: T; produced: Produced; calls: number }> {
  let lastProblem = "";
  for (let attempt = 1; attempt <= MAX_CALLS_PER_STEP; attempt++) {
    let result;
    try {
      result = await ai.generateText({
        system: prompt.system,
        messages: attempt === 1 ? prompt.messages : [...prompt.messages, { role: "user", content: `Your previous reply was not usable (${lastProblem}). Reply again with ONLY the JSON object described above.` }],
        json: true,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        timeoutMs: VIVA_CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof AIError && err.code === "timeout")) throw new VivaAiError(TIMEOUT_MESSAGE, "examiner_timeout");
      if (err instanceof AIError) throw new VivaAiError(err.message, "examiner_unavailable");
      throw err;
    }
    const raw = parseJsonObject(result.text);
    if (raw === null) {
      lastProblem = "it was not valid JSON";
      continue;
    }
    try {
      return { value: check(raw), produced: { model: result.model, isMock: result.isMock }, calls: attempt };
    } catch (err) {
      if (!(err instanceof VivaInvalid)) throw err;
      lastProblem = err.message;
    }
  }
  throw new VivaAiError(UNREADABLE_MESSAGE, "examiner_unreadable");
}

/** Asks the examiner for ONE question (at most two model calls). */
export function generateQuestion(ai: LLMProvider, input: QuestionPromptInput, signal?: AbortSignal) {
  return step<ValidQuestion>(ai, signal, buildQuestionPrompt(input), { temperature: 0.5, maxTokens: 500 }, (raw) => validateQuestion(raw, input.asked));
}

/** Asks the examiner to evaluate ONE answer (at most two model calls). */
export function evaluateAnswer(ai: LLMProvider, input: EvaluationPromptInput, signal?: AbortSignal) {
  return step<ValidEvaluation>(ai, signal, buildEvaluationPrompt(input), { temperature: 0.2, maxTokens: 700 }, validateEvaluation);
}
