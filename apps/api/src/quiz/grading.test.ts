import { describe, expect, it } from "vitest";
import { gradeAnswers, topicPerformance } from "./grading.js";

const qs = [
  { id: "q1", correctIndex: 0, topic: "Mechanics" },
  { id: "q2", correctIndex: 2, topic: "Mechanics" },
  { id: "q3", correctIndex: 1, topic: "Heat" },
  { id: "q4", correctIndex: 3, topic: null },
];

describe("gradeAnswers", () => {
  it("scores all-correct, all-wrong, partial and empty attempts", () => {
    expect(gradeAnswers(qs, new Map([["q1", 0], ["q2", 2], ["q3", 1], ["q4", 3]]))).toMatchObject({ correct: 4, incorrect: 0, unanswered: 0, total: 4, percentage: 100 });
    expect(gradeAnswers(qs, new Map([["q1", 1], ["q2", 0], ["q3", 0], ["q4", 0]]))).toMatchObject({ correct: 0, incorrect: 4, unanswered: 0, percentage: 0 });
    expect(gradeAnswers(qs, new Map([["q1", 0], ["q3", 0]]))).toMatchObject({ correct: 1, incorrect: 1, unanswered: 2, total: 4, percentage: 25 });
    expect(gradeAnswers(qs, new Map())).toMatchObject({ correct: 0, incorrect: 0, unanswered: 4, percentage: 0 });
  });

  it("records which answered questions were right, and leaves unanswered ones out", () => {
    const g = gradeAnswers(qs, new Map([["q1", 0], ["q2", 1]]));
    expect([...g.correctness]).toEqual([["q1", true], ["q2", false]]);
  });

  it("ignores answers to questions that are not part of the quiz", () => {
    const g = gradeAnswers(qs, new Map([["q1", 0], ["intruder", 0]]));
    expect(g).toMatchObject({ correct: 1, incorrect: 0, unanswered: 3 });
  });

  it("rounds percentages to two decimals and copes with an empty quiz", () => {
    expect(gradeAnswers([{ id: "a", correctIndex: 0, topic: null }, { id: "b", correctIndex: 0, topic: null }, { id: "c", correctIndex: 0, topic: null }], new Map([["a", 0]])).percentage).toBe(33.33);
    expect(gradeAnswers([], new Map())).toMatchObject({ total: 0, percentage: 0 });
  });
});

describe("topicPerformance", () => {
  it("groups real results by topic, weakest first, with unclassified last", () => {
    const rows = [
      { topic: "Mechanics", isCorrect: true },
      { topic: "Mechanics", isCorrect: true },
      { topic: "Heat", isCorrect: false },
      { topic: "Heat", isCorrect: true },
      { topic: null, isCorrect: false },
    ];
    expect(topicPerformance(rows)).toEqual([
      { topic: "Heat", correct: 1, total: 2, percentage: 50 },
      { topic: "Mechanics", correct: 2, total: 2, percentage: 100 },
      { topic: null, correct: 0, total: 1, percentage: 0 },
    ]);
  });

  it("returns nothing when there is nothing to report (no fake analytics)", () => {
    expect(topicPerformance([])).toEqual([]);
  });
});
