import { describe, expect, it } from "vitest";
import { answerScore, scoreLevel, SCORE_WEIGHTS } from "@copilot/shared";
import { buildResult, overallScore, type AnsweredQuestion } from "./scoring.js";
import { validateEvaluation, validateQuestion, VivaInvalid } from "./validate.js";

describe("score formula", () => {
  it("weights are the documented 40 / 30 / 20 / 10 and add up to 100%", () => {
    expect(SCORE_WEIGHTS).toEqual({ correctness: 0.4, completeness: 0.3, clarity: 0.2, confidence: 0.1 });
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("answer score = 10 x the weighted mean of the four 0-10 scores", () => {
    expect(answerScore({ correctness: 10, completeness: 10, clarity: 10, confidence: 10 })).toBe(100);
    expect(answerScore({ correctness: 0, completeness: 0, clarity: 0, confidence: 0 })).toBe(0);
    expect(answerScore({ correctness: 8, completeness: 6, clarity: 8, confidence: 7 })).toBe(73);
    expect(answerScore({ correctness: 10, completeness: 0, clarity: 0, confidence: 0 })).toBe(40);
    expect(answerScore({ correctness: 0, completeness: 0, clarity: 0, confidence: 10 })).toBe(10);
  });
  it("uses the same strong / weak cut-offs as topic mastery", () => {
    expect(scoreLevel(75)).toBe("strong");
    expect(scoreLevel(74.9)).toBe("developing");
    expect(scoreLevel(50)).toBe("developing");
    expect(scoreLevel(49.9)).toBe("weak");
  });
  it("the viva score is the mean of the answer scores", () => {
    expect(overallScore([73, 91, 50])).toBe(71.3);
    expect(overallScore([100])).toBe(100);
    expect(overallScore([])).toBe(0);
  });
});

const answered = (over: Partial<AnsweredQuestion> & Pick<AnsweredQuestion, "number" | "concept" | "score">): AnsweredQuestion => ({
  correctness: Math.round(over.score / 10),
  completeness: Math.round(over.score / 10),
  clarity: Math.round(over.score / 10),
  confidence: Math.round(over.score / 10),
  missingConcepts: [],
  ...over,
});

describe("buildResult (everything comes from the actual answers)", () => {
  const result = buildResult([
    answered({ number: 1, concept: "Activation energy", score: 90 }),
    answered({ number: 2, concept: "Collision theory", score: 40, missingConcepts: ["Collision frequency", "Activation energy"] }),
    answered({ number: 3, concept: "Catalysts", score: 60, missingConcepts: ["Alternative pathway"] }),
    answered({ number: 4, concept: "Rate laws", score: 30, missingConcepts: ["collision frequency"] }),
  ]);
  it("overall, level and dimension percentages", () => {
    expect(result.overall).toBe(55);
    expect(result.level).toBe("developing");
    expect(result.dimensions).toEqual({ correctness: 55, completeness: 55, clarity: 55, confidence: 55 });
  });
  it("strong areas are concepts of strong answers only", () => {
    expect(result.strongAreas).toEqual(["Activation energy"]);
  });
  it("areas to improve name low-scoring concepts and the ideas the evaluations found missing (most often first)", () => {
    expect(result.improveAreas).toContain("Review Rate laws (30%)");
    expect(result.improveAreas).toContain("Review Collision theory (40%)");
    expect(result.improveAreas.indexOf('Cover "Collision frequency" in your explanations')).toBeGreaterThanOrEqual(0);
    expect(result.improveAreas.filter((a) => /collision frequency/i.test(a))).toHaveLength(1); // spellings merged
    expect(result.weakConcepts.slice(0, 2)).toEqual(["Rate laws", "Collision theory"]);
  });
  it("invents nothing for an excellent viva", () => {
    const r = buildResult([answered({ number: 1, concept: "A", score: 95 }), answered({ number: 2, concept: "B", score: 85 })]);
    expect(r.level).toBe("strong");
    expect(r.strongAreas).toEqual(["A", "B"]);
    expect(r.improveAreas).toEqual([]);
    expect(r.weakConcepts).toEqual([]);
  });
  it("names the weakest dimension only when it is genuinely low", () => {
    const r = buildResult([{ ...answered({ number: 1, concept: "A", score: 80 }), clarity: 3 }]);
    expect(r.improveAreas).toEqual(["Clarity was your lowest area (30%)"]);
  });
  it("handles a viva with no answers", () => {
    expect(buildResult([])).toMatchObject({ overall: 0, strongAreas: [], improveAreas: [], weakConcepts: [] });
  });
});

describe("validateQuestion (the model's output is untrusted)", () => {
  const ok = { question: "Why does a higher temperature usually speed up a reaction?", concept: "Reaction rate", keyPoints: ["More energetic collisions", "Higher collision frequency"] };
  it("accepts a good question and cleans it", () => {
    expect(validateQuestion({ ...ok, question: "  Why does a higher temperature\n usually speed up a reaction?  ", extra: "ignored" }, [])).toEqual(ok);
  });
  it.each([
    ["null", null],
    ["an array", []],
    ["a missing question", { ...ok, question: "" }],
    ["a too-short question", { ...ok, question: "Why?" }],
    ["a missing concept", { ...ok, concept: "" }],
    ["no key points", { ...ok, keyPoints: [] }],
    ["key points that are not strings", { ...ok, keyPoints: [1, {}, null] }],
  ])("rejects %s", (_l, raw) => {
    expect(() => validateQuestion(raw, [])).toThrow(VivaInvalid);
  });
  it("rejects a question that repeats an earlier one (even reworded slightly)", () => {
    const asked = [{ text: "Why does a higher temperature usually speed up a chemical reaction?" }];
    expect(() => validateQuestion(ok, asked)).toThrow("repeats");
    expect(() => validateQuestion({ ...ok, question: "What does a catalyst do to the activation energy of a reaction?" }, asked)).not.toThrow();
  });
  it("limits lengths and the number of key points", () => {
    const q = validateQuestion({ question: "x ".repeat(500), concept: "c".repeat(200), keyPoints: Array.from({ length: 9 }, (_, i) => `point number ${i}`) }, []);
    expect(q.question.length).toBeLessThanOrEqual(400);
    expect(q.concept.length).toBeLessThanOrEqual(60);
    expect(q.keyPoints).toHaveLength(5);
  });
});

describe("validateEvaluation (scores must be 0-10; nothing malformed is stored)", () => {
  const ok = { correctness: 8, completeness: 6, clarity: 8, confidence: 7, feedback: "You explained the main idea well but left out activation energy.", missingConcepts: ["Activation energy"], shouldFollowUp: false };
  it("accepts a good evaluation", () => {
    expect(validateEvaluation(ok)).toEqual(ok);
  });
  it("rounds decimals and accepts numeric strings", () => {
    expect(validateEvaluation({ ...ok, correctness: 7.6, clarity: "9" })).toMatchObject({ correctness: 8, clarity: 9 });
  });
  it.each([
    ["above 10", { correctness: 11 }],
    ["a percentage instead of 0-10", { correctness: 85 }],
    ["below 0", { clarity: -1 }],
    ["not a number", { completeness: "high" }],
    ["missing", { confidence: undefined }],
    ["NaN", { correctness: Number.NaN }],
    ["no feedback", { feedback: "" }],
    ["too-short feedback", { feedback: "ok" }],
  ])("rejects a score/feedback problem: %s", (_l, patch) => {
    expect(() => validateEvaluation({ ...ok, ...patch })).toThrow(VivaInvalid);
  });
  it("rejects non-objects", () => {
    for (const raw of [null, "text", 5, []]) expect(() => validateEvaluation(raw)).toThrow(VivaInvalid);
  });
  it("cleans missing concepts: dedupes, drops blanks, limits", () => {
    const e = validateEvaluation({ ...ok, missingConcepts: ["A thing", "a THING", "", "  ", 5, "Other idea", "x".repeat(300)] });
    expect(e.missingConcepts).toHaveLength(3);
    expect(e.missingConcepts[2]!.length).toBeLessThanOrEqual(80);
    expect(validateEvaluation({ ...ok, missingConcepts: "none" }).missingConcepts).toEqual([]);
  });
  it("shouldFollowUp is true only for a real true", () => {
    expect(validateEvaluation({ ...ok, shouldFollowUp: true }).shouldFollowUp).toBe(true);
    expect(validateEvaluation({ ...ok, shouldFollowUp: "yes" }).shouldFollowUp).toBe(false);
    expect(validateEvaluation({ ...ok, shouldFollowUp: undefined }).shouldFollowUp).toBe(false);
  });
});
