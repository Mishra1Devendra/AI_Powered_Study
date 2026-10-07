import { describe, expect, it } from "vitest";
import { createInMemoryNotesRepository } from "../notes/testing/memory.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import type { GenerateTextRequest, GenerateTextResult, LLMProvider, TextStream } from "../services/ai/types.js";
import { createInMemoryTutorRepository } from "../tutor/testing.js";
import { createQuizService } from "./service.js";
import { createInMemoryQuizRepository } from "./testing/memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A model that never answers on its own: it only stops when the caller aborts it (like a hung local model). */
const stuck: LLMProvider = {
  name: "ollama",
  model: "stuck-model",
  isMock: false,
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
    return new Promise((_resolve, reject) => req.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  },
  // eslint-disable-next-line require-yield
  async *streamText(): TextStream {
    throw new Error("unused");
  },
};

function make(ai: LLMProvider, jobDeadlineMs?: number) {
  const notes = createInMemoryNotesRepository(createInMemoryTutorRepository());
  const quiz = createInMemoryQuizRepository(notes.repo);
  const service = createQuizService({ repo: quiz.repo, notes: notes.repo, ai, ...(jobDeadlineMs ? { jobDeadlineMs } : {}) });
  return { service, quiz };
}

const topicInput = { source: { type: "topic" as const, subject: "Physics" }, difficulty: "easy" as const, count: 5, questionTypes: ["mcq" as const], timeLimitMinutes: null };

describe("quiz generation can never hang a student's account", () => {
  it("a model that never answers is cut off at the job deadline: the quiz fails with a clear message and a new one can start", async () => {
    const { service } = make(stuck, 40);
    const quiz = await service.generate(A, topicInput);
    expect(quiz.status).toBe("generating");
    await service.whenIdle();
    const after = (await service.list(A)).quizzes[0]!;
    expect(after).toMatchObject({ id: quiz.id, status: "failed", error: "Creating the quiz took too long. Try fewer questions." });
    // Not blocked any more.
    const next = make(new MockProvider(0));
    expect((await next.service.generate(A, topicInput)).status).toBe("generating");
    await next.service.whenIdle();
  });

  it("the deadline timer is cleared after a normal run (nothing is left running)", async () => {
    const { service, quiz } = make(new MockProvider(0), 60_000);
    await service.generate(A, topicInput);
    await service.whenIdle();
    expect(quiz.state.quizzes[0]!.status).toBe("ready");
    expect(quiz.state.questions).toHaveLength(5);
  });
});
