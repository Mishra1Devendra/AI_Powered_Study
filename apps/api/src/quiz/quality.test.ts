import { describe, expect, it } from "vitest";
import { FACT_CHUNKS, MCQ_FACTS, TF_FACTS, mcqItem, mcqSource, tfItem } from "./testing/facts.js";
import { checkQuality, contentWords, coverage, locateEvidence, type QualityContext } from "./quality.js";
import { validateQuestions, type ValidationContext } from "./validate.js";

const passages = FACT_CHUNKS.map((c, i) => ({ key: `S${i + 1}`, content: c.text }));
const grounded: QualityContext = { passages, grounded: true };
const ungrounded: QualityContext = { passages: [], grounded: false };

/** Runs the real pipeline (structure + quality gate) on one raw item; returns what was accepted/rejected. */
function run(item: unknown, ctx: QualityContext = grounded, over: Partial<ValidationContext> = {}) {
  const base: ValidationContext = {
    remaining: { mcq: 5, true_false: 5 },
    difficulty: "mixed",
    allowedTopics: [],
    sourceKeys: passages.map((p) => p.key),
    existing: [],
    quality: (q) => checkQuality(q, ctx),
    ...over,
  };
  return validateQuestions([item], base);
}
const codes = (item: unknown, ctx?: QualityContext) => run(item, ctx).rejected.map((r) => `${r.code}: ${r.reason}`);
const accepts = (item: unknown, ctx?: QualityContext) => expect(run(item, ctx).rejected, JSON.stringify(item)).toEqual([]);

describe("the quality gate accepts good questions", () => {
  it.each(MCQ_FACTS.map((_, i) => i))("multiple-choice fact %i", (i) => accepts(mcqItem(i)));
  it.each(TF_FACTS.map((_, i) => i))("true/false fact %i (true or false)", (i) => accepts({ ...tfItem(i) }));
  it("accepts a topic quiz question (no notes) as long as the wording is sound", () => {
    accepts({ ...mcqItem(0), evidence: undefined, source: undefined }, ungrounded);
  });
});

describe("questions that are not backed by the notes are rejected", () => {
  it("no quote at all", () => {
    expect(codes(mcqItem(0, { evidence: undefined }))).toEqual(["unsupported: no quote from the notes supports this question"]);
    expect(codes(mcqItem(0, { evidence: "Short quote." }))[0]).toMatch(/^unsupported: no quote/);
  });

  it("a quote that is not in the notes (invented evidence)", () => {
    const fake = mcqItem(0, { evidence: "Mitochondria are the powerhouse of every living organism on Earth." });
    expect(codes(fake)).toEqual(["unsupported: the quote given as evidence is not in your notes"]);
  });

  it("a real quote, but the question is about something else", () => {
    // The known 3B failure: a question that sounds on-topic but is not what the quote says.
    const wandering = mcqItem(8, {
      question: "Which process is the reverse of heat transfer by convection?",
      options: ["Conduction", "Radiation", "Condensation", "Boiling"],
      evidence: MCQ_FACTS[10]!.evidence, // the convection sentence
      source: mcqSource(10),
    });
    expect(codes(wandering)[0]).toMatch(/^unsupported: the question or its answer is not covered/);
  });

  it("a correct answer that does not appear anywhere in the notes", () => {
    const item = mcqItem(0, { options: ["Chloroplasts", "Ribosomes", "Lysosomes", "Vacuoles"] });
    expect(codes(item)[0]).toMatch(/^unsupported:/);
  });

  it("is lenient about small differences in the quote (case, punctuation, plural)", () => {
    accepts(mcqItem(0, { evidence: "MITOCHONDRIA produce most of the ATP that a cell uses for energy" }));
    expect(locateEvidence("Ribosomes build protein by translating messenger RNA in the cytoplasm", passages)?.key).toBe("S1");
  });

  it("finds the right passage even when the model cited the wrong one", () => {
    accepts(mcqItem(0, { source: "S5" }));
    expect(locateEvidence(MCQ_FACTS[0]!.evidence, passages, "S5")?.key).toBe("S1");
  });
});

describe("true/false consistency with the notes", () => {
  it("a statement marked true must be supported by its quote", () => {
    const item = tfItem(0, { question: "Lysosomes digest worn out cell parts using strong enzymes.", correctAnswer: true });
    expect(codes(item)[0]).toMatch(/^statement: the statement is marked true but the quote does not support it/);
  });

  it("a statement copied word for word from the notes cannot be marked false", () => {
    const item = tfItem(2, { correctAnswer: false });
    expect(codes(item)).toEqual(["statement: the statement matches the notes word for word but is marked false"]);
  });

  it("a false statement must still be about the notes", () => {
    const item = tfItem(3, { question: "Volcanic eruptions release carbon dioxide into the atmosphere quickly.", correctAnswer: false });
    expect(codes(item)[0]).toMatch(/^unsupported: the statement is not about anything in the notes/);
  });

  it("must be a statement, not a question, and not too short", () => {
    expect(codes(tfItem(0, { question: "Do ribosomes make proteins in the cell?" }))[0]).toMatch(/^weak_question: a true\/false item must be a statement/);
    expect(codes(tfItem(0, { question: "Ribosomes make protein." }))[0]).toMatch(/^weak_question: the statement is too short/);
  });
});

describe("answer options", () => {
  it("rejects options that are near-identical", () => {
    const item = mcqItem(0, { options: ["Mitochondria", "The mitochondria", "Lysosomes", "Vacuoles"] });
    expect(codes(item)).toEqual(["options: two options say almost the same thing"]);
    expect(codes(mcqItem(9, { options: ["As electromagnetic waves", "As electromagnetic wave", "By moving fluid", "By direct contact"] }))[0]).toMatch(/^options: two options/);
  });

  it("rejects an option that just repeats the question", () => {
    const item = mcqItem(0, { options: ["Which organelle produces most of the ATP a cell uses", "Ribosomes", "Lysosomes", "Vacuoles"] });
    expect(codes(item)[0]).toBe("options: an option just repeats the question");
  });

  it('rejects combined answers ("both A and B", "all of these")', () => {
    for (const bad of ["Both ribosomes and lysosomes", "A and B", "All of these", "Neither of them", "None of these"]) {
      expect(codes(mcqItem(0, { options: ["Mitochondria", bad, "Lysosomes", "Vacuoles"] }))[0], bad).toMatch(/combined answers|ambiguous/);
    }
  });

  it("rejects options that are whole sentences copied from the notes", () => {
    const item = mcqItem(10, {
      question: "Which statement about heat is stated in the notes?",
      options: [MCQ_FACTS[10]!.evidence, MCQ_FACTS[8]!.evidence, MCQ_FACTS[9]!.evidence, "Heat is a form of sound"],
      explanation: "The notes say that convection carries heat through the bulk movement of a fluid.",
    });
    expect(codes(item)[0]).toBe("options: the options are whole sentences copied from the notes");
  });

  it("rejects a paragraph used as an option", () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    expect(codes(mcqItem(0, { options: ["Mitochondria", long, "Lysosomes", "Vacuoles"] }))[0]).toBe("options: an option is a whole paragraph instead of a short answer");
  });

  it("rejects an obvious giveaway: the right answer is far longer than the rest", () => {
    const item = mcqItem(4, { options: ["By lowering the activation energy that the reaction needs in order to proceed quickly", "By heat", "By salt", "By air"] });
    expect(codes(item)[0]).toBe("options: the correct answer is obviously longer than the others");
  });

  it("rejects a question that is too short to be clear", () => {
    expect(codes(mcqItem(0, { question: "What makes ATP?" }))[0]).toBe("weak_question: the question is too short to be clear");
  });
});

describe("explanations", () => {
  it("must say something about the question or its answer", () => {
    const item = mcqItem(0, { explanation: "This is a good question and the answer is correct for sure." });
    expect(codes(item)).toEqual(["explanation: the explanation does not talk about the question or its answer"]);
  });

  it("must not just repeat the question, and must be a sensible length", () => {
    expect(codes(mcqItem(0, { explanation: "Which organelle produces most of the ATP a cell uses?" }))[0]).toMatch(/^explanation:/);
    expect(codes(mcqItem(0, { explanation: "Mitochondria." }))[0]).toMatch(/explanation/);
    expect(codes(mcqItem(0, { explanation: `Mitochondria ${"respire ".repeat(80)}` }))[0]).toBe("explanation: the explanation is too long");
  });
});

describe("duplicates", () => {
  it("rejects the same question twice in one batch and against earlier questions", () => {
    const { accepted, rejected } = validateQuestions([mcqItem(0), mcqItem(0), mcqItem(1)], {
      remaining: { mcq: 5 },
      difficulty: "mixed",
      allowedTopics: [],
      sourceKeys: passages.map((p) => p.key),
      existing: [],
      quality: (q) => checkQuality(q, grounded),
    });
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([{ index: 1, reason: "duplicate of another question", code: "duplicate" }]);
    expect(run(mcqItem(0), grounded, { existing: [MCQ_FACTS[0]!.question] }).accepted).toEqual([]);
  });

  it("catches a light rewording of the same question", () => {
    const reworded = mcqItem(0, { question: "Which organelle makes most of the ATP that a cell uses?" });
    expect(run(reworded, grounded, { existing: [MCQ_FACTS[0]!.question] }).rejected[0]?.code).toBe("duplicate");
  });
});

describe("the gate on topic quizzes and on the demo provider (no notes to check against)", () => {
  it("still applies the wording and option checks", () => {
    expect(codes(mcqItem(0, { options: ["Mitochondria", "The mitochondria", "Lysosomes", "Vacuoles"] }), ungrounded)).toEqual(["options: two options say almost the same thing"]);
    expect(codes(mcqItem(0, { explanation: "Totally unrelated words here, nothing at all to see." }), ungrounded)[0]).toMatch(/^explanation:/);
  });

  it("does not demand a quote it could not check", () => {
    accepts({ ...mcqItem(5), evidence: undefined }, ungrounded);
  });
});

describe("helpers", () => {
  it("contentWords drops filler and short words and folds plurals/tenses", () => {
    expect(contentWords("Which organelles produce the ATP that cells used?").sort()).toEqual(["cell", "organell", "produc", "used"].sort());
  });
  it("coverage counts the share of words found", () => {
    expect(coverage(["a1", "b2", "c3", "d4"], new Set(["a1", "b2"]))).toBe(0.5);
    expect(coverage([], new Set())).toBe(1);
  });
});
