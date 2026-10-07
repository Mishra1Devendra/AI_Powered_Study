import { describe, expect, it } from "vitest";
import { isDuplicate, parseQuestionsJson, salvageQuestions, shuffleOptions, shuffled, similarity, validateQuestions, type ValidationContext } from "./validate.js";

const mcq = (over: Record<string, unknown> = {}) => ({
  type: "mcq",
  question: "Which organelle produces most of the cell's ATP?",
  options: ["Mitochondrion", "Ribosome", "Golgi apparatus", "Lysosome"],
  correctAnswer: 0,
  explanation: "Mitochondria carry out oxidative phosphorylation, which makes most of the ATP.",
  difficulty: "medium",
  ...over,
});
const tf = (over: Record<string, unknown> = {}) => ({
  type: "true_false",
  question: "Ribosomes are the site of protein synthesis in the cell.",
  correctAnswer: true,
  explanation: "Ribosomes translate mRNA into protein.",
  difficulty: "easy",
  ...over,
});

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  remaining: { mcq: 5, true_false: 5 },
  difficulty: "mixed",
  allowedTopics: [],
  sourceKeys: [],
  existing: [],
  ...over,
});

describe("parseQuestionsJson", () => {
  it("accepts an object, a bare array, fenced Markdown and JSON wrapped in prose", () => {
    const q = [mcq()];
    expect(parseQuestionsJson(JSON.stringify({ questions: q }))).toHaveLength(1);
    expect(parseQuestionsJson(JSON.stringify(q))).toHaveLength(1);
    expect(parseQuestionsJson("```json\n" + JSON.stringify({ questions: q }) + "\n```")).toHaveLength(1);
    expect(parseQuestionsJson("Sure! Here you go: " + JSON.stringify({ questions: q }) + " Hope it helps.")).toHaveLength(1);
  });

  it("returns null for anything unusable", () => {
    for (const bad of ["", "not json", "{", '{"questions": "nope"}', '{"items": []}', "42", "null"]) expect(parseQuestionsJson(bad)).toBeNull();
  });
});

describe("validateQuestions: accepts well-formed questions", () => {
  it("accepts a valid MCQ and a valid true/false, normalising true/false to True,False", () => {
    const { accepted, rejected } = validateQuestions([mcq(), tf()], ctx());
    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({ type: "mcq", correctIndex: 0, options: ["Mitochondrion", "Ribosome", "Golgi apparatus", "Lysosome"] });
    expect(accepted[1]).toMatchObject({ type: "true_false", options: ["True", "False"], correctIndex: 0 });
    expect(validateQuestions([tf({ correctAnswer: false })], ctx()).accepted[0]!.correctIndex).toBe(1);
  });

  it("understands the answer given as a letter, a numeric string, or the option text", () => {
    for (const correctAnswer of ["A", "a", "0", "Mitochondrion", " mitochondrion "]) {
      expect(validateQuestions([mcq({ correctAnswer })], ctx()).accepted[0]?.correctIndex, String(correctAnswer)).toBe(0);
    }
    expect(validateQuestions([mcq({ correctAnswer: "C" })], ctx()).accepted[0]?.correctIndex).toBe(2);
    expect(validateQuestions([tf({ correctAnswer: "False" })], ctx()).accepted[0]?.correctIndex).toBe(1);
  });
});

describe("validateQuestions: rejects malformed questions (nothing invalid is ever kept)", () => {
  const reasons = (item: unknown, c = ctx()) => validateQuestions([item], c).rejected.map((r) => r.reason);

  it("rejects non-objects and unsupported types", () => {
    expect(reasons(null)).toEqual(["not an object"]);
    expect(reasons("question")).toEqual(["not an object"]);
    expect(reasons([1, 2])).toEqual(["not an object"]);
    expect(reasons(mcq({ type: "essay" }))).toEqual(["unsupported question type"]);
    expect(reasons(mcq({ type: "short_answer" }))).toEqual(["unsupported question type"]); // not generatable yet
  });

  it("rejects missing or implausible question text and explanation", () => {
    expect(reasons(mcq({ question: "" }))).toHaveLength(1);
    expect(reasons(mcq({ question: "Why?" }))).toHaveLength(1);
    expect(reasons(mcq({ question: "x".repeat(501) }))).toHaveLength(1);
    expect(reasons(mcq({ question: 42 }))).toHaveLength(1);
    expect(reasons(mcq({ explanation: undefined }))).toHaveLength(1);
    expect(reasons(mcq({ explanation: "ok" }))).toHaveLength(1);
  });

  it("rejects MCQs without exactly 4 distinct, non-empty options", () => {
    expect(reasons(mcq({ options: undefined }))).toHaveLength(1);
    expect(reasons(mcq({ options: ["a", "b", "c"] }))).toHaveLength(1);
    expect(reasons(mcq({ options: ["a", "b", "c", "d", "e"] }))).toHaveLength(1);
    expect(reasons(mcq({ options: ["a", "b", "c", ""] }))).toHaveLength(1);
    expect(reasons(mcq({ options: ["Same", "same ", "Other", "Another"] }))).toEqual(["options are not distinct"]);
  });

  it("rejects a multiple-choice 'question' that is really a statement copied from the notes", () => {
    const statement = mcq({ question: "A gas that expands against a piston does work and its internal energy falls." });
    expect(reasons(statement)).toEqual(["a multiple-choice question must be phrased as a question"]);
    // ...but a question, a blank, or a lead-in to the options is fine.
    for (const question of ["Which organelle produces most of the cell's ATP?", "The organelle that produces most of the cell's ATP is ____.", "The organelle that produces most of the cell's ATP is:", "The powerhouse of the cell is called the..."]) {
      expect(validateQuestions([mcq({ question })], ctx()).accepted, question).toHaveLength(1);
    }
    // True/false statements are statements by nature.
    expect(validateQuestions([tf()], ctx()).accepted).toHaveLength(1);
  });

  it("ignores field names a small model leaked at the END of the options, but still rejects genuinely wrong option lists", () => {
    const leaked = mcq({ options: ["Mitochondrion", "Ribosome", "Golgi apparatus", "Lysosome", "explanation", "difficulty", "source"] });
    expect(validateQuestions([leaked], ctx()).accepted[0]).toMatchObject({ options: ["Mitochondrion", "Ribosome", "Golgi apparatus", "Lysosome"], correctIndex: 0 });
    // a leaked name in the middle would shift positions: not touched, so the question is rejected
    expect(reasons(mcq({ options: ["Mitochondrion", "explanation", "Golgi apparatus", "Lysosome", "Ribosome"] }))).toHaveLength(1);
    // two real options plus a leaked pair is not rescued into something else: it is rejected
    expect(reasons(mcq({ options: ["Mitochondrion", "Ribosome", "Lysosome", "explanation", "difficulty"] }))).toEqual(["a multiple-choice question needs exactly 4 options"]);
    // a lone word that happens to match a field name, as a genuine 4th option, is left alone
    expect(validateQuestions([mcq({ options: ["Mitochondrion", "Ribosome", "Lysosome", "Source"] })], ctx()).accepted[0]!.options[3]).toBe("Source");
  });

  it("rejects ambiguous 'all/none of the above' options", () => {
    expect(reasons(mcq({ options: ["Mitochondrion", "Ribosome", "Lysosome", "All of the above"] }))).toHaveLength(1);
    expect(reasons(mcq({ options: ["Mitochondrion", "Ribosome", "Lysosome", "None of the above"] }))).toHaveLength(1);
  });

  it("rejects a correct answer that is not exactly one valid option", () => {
    for (const correctAnswer of [4, -1, 1.5, "E", "Nucleus", null, undefined, [0, 1], { a: 1 }]) {
      expect(reasons(mcq({ correctAnswer })), JSON.stringify(correctAnswer)).toEqual(["the correct answer is not exactly one of the options"]);
    }
    expect(reasons(tf({ correctAnswer: "maybe" }))).toEqual(["the correct answer must be true or false"]);
    expect(reasons(tf({ correctAnswer: 1 }))).toEqual(["the correct answer must be true or false"]);
  });

  it("keeps good questions when others in the same batch are bad", () => {
    const { accepted, rejected } = validateQuestions([mcq(), mcq({ question: "Another valid question about cell biology basics?", options: ["a1", "a2", "a3", "a1"] }), tf()], ctx());
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([{ index: 1, reason: "options are not distinct", code: "structure" }]);
  });
});

describe("validateQuestions: counts, duplicates, topics, difficulty", () => {
  it("never accepts more questions of a type than still needed", () => {
    const { accepted, rejected } = validateQuestions(
      [mcq(), mcq({ question: "Which organelle contains the cell's DNA?", options: ["Nucleus", "Vacuole", "Ribosome", "Lysosome"] }), tf()],
      ctx({ remaining: { mcq: 1, true_false: 1 } }),
    );
    expect(accepted.map((q) => q.type)).toEqual(["mcq", "true_false"]);
    expect(rejected[0]!.reason).toMatch(/more mcq questions than requested/);
    expect(validateQuestions([tf()], ctx({ remaining: { mcq: 3 } })).rejected[0]!.reason).toMatch(/more true_false/);
  });

  it("rejects duplicates inside the batch, against earlier questions, and near-copies", () => {
    const same = validateQuestions([mcq(), mcq()], ctx());
    expect(same.accepted).toHaveLength(1);
    expect(same.rejected[0]!.reason).toBe("duplicate of another question");

    const earlier = validateQuestions([mcq()], ctx({ existing: ["Which organelle produces most of the cell's ATP?"] }));
    expect(earlier.accepted).toEqual([]);

    const near = validateQuestions([mcq({ question: "Which organelle produces most of the cells' ATP?" })], ctx({ existing: ["Which organelle produces most of the cell's ATP?"] }));
    expect(near.accepted).toEqual([]);

    const different = validateQuestions([mcq({ question: "What is the function of the Golgi apparatus?" })], ctx({ existing: ["Which organelle produces most of the cell's ATP?"] }));
    expect(different.accepted).toHaveLength(1);
  });

  it("measures similarity sensibly", () => {
    expect(similarity("What is entropy?", "what is ENTROPY")).toBe(1);
    expect(similarity("The mitochondrion makes ATP", "Photosynthesis happens in chloroplasts")).toBeLessThan(0.2);
    expect(isDuplicate("What is entropy?", ["Define osmosis", "what is entropy"])).toBe(true);
  });

  it("only keeps a topic that is one of the allowed labels (case-insensitively); never invents one", () => {
    const c = ctx({ allowedTopics: ["Cell Biology", "Genetics"] });
    expect(validateQuestions([mcq({ topic: "cell biology" })], c).accepted[0]!.topic).toBe("Cell Biology");
    expect(validateQuestions([mcq({ topic: "Quantum Physics" })], c).accepted[0]!.topic).toBeNull();
    expect(validateQuestions([mcq({ topic: 5 })], c).accepted[0]!.topic).toBeNull();
    expect(validateQuestions([mcq({ topic: "Cell Biology" })], ctx()).accepted[0]!.topic).toBeNull(); // no labels allowed
  });

  it("only keeps a source key that was really supplied", () => {
    const c = ctx({ sourceKeys: ["S1", "S2"] });
    expect(validateQuestions([mcq({ source: "S2" })], c).accepted[0]!.sourceKey).toBe("S2");
    expect(validateQuestions([mcq({ source: "S9" })], c).accepted[0]!.sourceKey).toBeNull();
    expect(validateQuestions([mcq({ source: "page 4" })], c).accepted[0]!.sourceKey).toBeNull();
  });

  it("forces the requested difficulty, and validates it for mixed quizzes", () => {
    expect(validateQuestions([mcq({ difficulty: "hard" })], ctx({ difficulty: "easy" })).accepted[0]!.difficulty).toBe("easy");
    expect(validateQuestions([mcq({ difficulty: "hard" })], ctx({ difficulty: "mixed" })).accepted[0]!.difficulty).toBe("hard");
    expect(validateQuestions([mcq({ difficulty: "impossible" })], ctx({ difficulty: "mixed" })).accepted[0]!.difficulty).toBe("medium");
  });

  it("strips control characters and collapses whitespace in stored text", () => {
    const q = validateQuestions([mcq({ question: "Which\u0000 organelle   produces\n most of the cell's ATP?" })], ctx()).accepted[0]!;
    expect(q.text).toBe("Which organelle produces most of the cell's ATP?");
  });
});

describe("shuffling", () => {
  it("shuffled is a permutation and deterministic for a given RNG", () => {
    const seq = [0.1, 0.9, 0.4, 0.7];
    const make = () => { let i = 0; return () => seq[i++ % seq.length]!; };
    const a = shuffled([1, 2, 3, 4, 5], make());
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(shuffled([1, 2, 3, 4, 5], make())).toEqual(a);
  });

  it("shuffleOptions keeps pointing at the same correct option text", () => {
    const base = validateQuestions([mcq({ correctAnswer: 2 })], ctx()).accepted[0]!; // "Golgi apparatus"
    for (let seed = 1; seed <= 25; seed++) {
      let s = seed;
      const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const out = shuffleOptions(base, rng);
      expect(out.options[out.correctIndex]).toBe("Golgi apparatus");
      expect([...out.options].sort()).toEqual([...base.options].sort());
    }
  });

  it("does not reorder True/False", () => {
    const q = validateQuestions([tf({ correctAnswer: false })], ctx()).accepted[0]!;
    expect(shuffleOptions(q, () => 0.3)).toEqual(q);
  });
});

describe("replies cut off at the output limit", () => {
  const full = JSON.stringify({ questions: [mcq(), tf(), mcq({ question: "Which organelle contains the cell's DNA?" })] });

  it("keeps the complete questions and drops the unfinished one", () => {
    const cut = full.slice(0, full.length - 40); // the third question is incomplete
    const got = parseQuestionsJson(cut);
    expect(got).toHaveLength(2);
    expect((got![0] as { question: string }).question).toBe(mcq().question);
    expect((got![1] as { type: string }).type).toBe("true_false");
  });

  it("copes with braces and quotes inside strings", () => {
    const tricky = '{"questions":[{"type":"mcq","question":"What does {x} mean in \\"set\\" notation?","options":["a","b","c","d"],"correctAnswer":0,"explanation":"It is a set."},{"type":"mcq","question":"cut';
    expect(salvageQuestions(tricky)).toHaveLength(1);
  });

  it("returns nothing usable from text with no complete question", () => {
    expect(parseQuestionsJson('{"questions":[{"type":"mcq","question":"Which')).toBeNull();
    expect(parseQuestionsJson("I cannot help with that.")).toBeNull();
    expect(salvageQuestions("no json here")).toBeNull();
  });

  it("salvaged questions still go through every check", () => {
    const cut = JSON.stringify({ questions: [mcq({ options: ["a", "a", "b", "c"] }), mcq()] }) + "garbage";
    const raw = parseQuestionsJson(cut)!;
    const { accepted, rejected } = validateQuestions(raw, ctx());
    expect(accepted).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("options are not distinct");
  });
});
