import { describe, expect, it } from "vitest";
import type { PlanInput } from "@copilot/shared";
import type { GenerateTextRequest, LLMProvider, TextStream } from "../services/ai/types.js";
import { MockProvider } from "../services/ai/mock-provider.js";
import { createPlannerService, effectiveStatus } from "./service.js";
import { createInMemoryPlannerRepository } from "./testing/memory.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = () => new Date(Date.UTC(2026, 9, 5, 12));
const input: PlanInput = {
  title: "Boards",
  examDate: "2026-11-02",
  targetScore: null,
  minutesPerDay: 60,
  knowledgeLevel: "beginner",
  subjects: [{ name: "Physics", priority: "high", topics: [] }],
  studyDays: [1, 2, 3, 4, 5],
  preferredTime: "any",
};

function recording(inner: LLMProvider = new MockProvider(0)) {
  const requests: GenerateTextRequest[] = [];
  const ai: LLMProvider = { name: inner.name, model: inner.model, isMock: inner.isMock, generateText: (r) => (requests.push(r), inner.generateText(r)), streamText: (r) => inner.streamText(r) };
  return { ai, requests };
}

const quizTopics = async () => [
  { topic: "Optics", correct: 1, total: 5, percentage: 20 },
  { topic: "Waves", correct: 2, total: 5, percentage: 40 },
  { topic: "Heat", correct: 4, total: 5, percentage: 80 }, // strong
  { topic: "Sound", correct: 0, total: 1, percentage: 0 }, // too few questions to judge
  { topic: null, correct: 0, total: 9, percentage: 0 }, // unknown topic
];

describe("planner service", () => {
  it("uses only real, well-evidenced weak quiz topics (weakest first), in options and in the prompt", async () => {
    const mem = createInMemoryPlannerRepository(now);
    const r = recording();
    const service = createPlannerService({ repo: mem.repo, ai: r.ai, quizTopics, now });
    const options = await service.options(A);
    expect(options.weakTopics.map((w) => w.topic)).toEqual(["Optics", "Waves"]);
    await service.generate(A, input);
    await service.whenIdle();
    expect(r.requests[0]!.system).toContain('"Optics", "Waves"');
    expect(mem.plans[0]!.weakTopics).toEqual(["Optics", "Waves"]);
  });

  it("fails the plan (never leaves it spinning) when the whole job passes its deadline", async () => {
    const mem = createInMemoryPlannerRepository(now);
    const never: LLMProvider = {
      name: "ollama",
      model: "slow",
      isMock: false,
      generateText: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      // eslint-disable-next-line require-yield
      async *streamText(): TextStream {
        throw new Error("not used");
      },
    };
    const service = createPlannerService({ repo: mem.repo, ai: never, quizTopics: async () => [], now, jobDeadlineMs: 20 });
    await service.generate(A, input);
    await service.whenIdle();
    expect(mem.plans[0]).toMatchObject({ status: "failed" });
    expect(mem.plans[0]!.error).toContain("took too long");
    expect(mem.sessions).toHaveLength(0);
  });

  it("a database failure while saving fails the plan with a generic message and saves nothing else", async () => {
    const mem = createInMemoryPlannerRepository(now);
    mem.knobs.failComplete = true;
    const errors: unknown[] = [];
    const service = createPlannerService({ repo: mem.repo, ai: new MockProvider(0), quizTopics: async () => [], now, onError: (e) => errors.push(e) });
    await service.generate(A, input);
    await service.whenIdle();
    expect(mem.plans[0]).toMatchObject({ status: "failed", error: "Something went wrong while creating the plan. Please try again." });
    expect(errors).toHaveLength(1);
  });

  it("derives 'missed' without writing anything", () => {
    expect(effectiveStatus({ status: "planned", date: "2026-10-01" }, "2026-10-05")).toBe("missed");
    expect(effectiveStatus({ status: "in_progress", date: "2026-10-04" }, "2026-10-05")).toBe("missed");
    expect(effectiveStatus({ status: "planned", date: "2026-10-05" }, "2026-10-05")).toBe("planned");
    expect(effectiveStatus({ status: "completed", date: "2026-10-01" }, "2026-10-05")).toBe("completed");
    expect(effectiveStatus({ status: "skipped", date: "2026-10-01" }, "2026-10-05")).toBe("skipped");
  });
});
