import { normalizeText, similarity, type ValidQuestion } from "./validate.js";

/**
 * Basic QUALITY checks, run after a question is structurally valid.
 *
 * What this is: cheap, deterministic text checks that catch the usual failures of small local
 * models - questions about things the notes never say, answer options copied from the notes as
 * whole sentences, near-identical options, an explanation that has nothing to do with the question,
 * a True/False statement that contradicts its own evidence.
 *
 * What this is NOT: fact verification. Nothing here can know that a statement is true. For a notes
 * quiz the model must supply a verbatim quote ("evidence"); we verify that the quote really is in the
 * notes and that the question and the right answer are covered by it. That makes invented content
 * much less likely to get through, but a question can still be pointless, awkward or subtly wrong.
 */

export type QualityCode = "unsupported" | "options" | "explanation" | "statement" | "weak_question";

export interface QualityFailure {
  code: QualityCode;
  reason: string;
}

export interface QualityPassage {
  key: string;
  content: string;
}

export interface QualityContext {
  passages: readonly QualityPassage[];
  /**
   * Check the question against the supplied notes. False for subject/topic quizzes (there is no
   * material) and for the offline demo provider (its placeholder text is not about any material).
   */
  grounded: boolean;
}

const STOPWORDS = new Set(
  "about above after again against also because been before being below between both cannot could does doing down during each from further have having here herself himself into itself just more most myself once only other ourselves over same should some such than that their theirs them themselves then there these they this those through under until very were what when where which while who whom whose will with would your yours yourself yourselves following correct answer true false statement question".split(" "),
);

const INTERROGATIVE = /^(what|which|who|whom|whose|when|where|why|how|is|are|was|were|does|do|did|can|could|will|would|should)\b/i;
const COMBINED_ANSWER = /^(both|either|neither)\b|\b(a|b|c|d)\s*(and|&|,)\s*(a|b|c|d)\b|^(all|none)\s+(of\s+)?(these|them|those)\b|\bnot (listed|given)\b/i;

const MAX_OPTION_WORDS = 25;
const MIN_QUESTION_WORDS = 5;
const MIN_STATEMENT_WORDS = 6;
const MAX_EXPLANATION_CHARS = 500;
const MIN_EXPLANATION_CHARS = 15;
const MIN_EVIDENCE_WORDS = 4;
const SIMILAR_OPTIONS = 0.8;

const wordCount = (s: string) => normalizeText(s).split(" ").filter(Boolean).length;

/** Light stemming so "absorbs"/"absorbed"/"absorbing" match. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  let r = w.replace(/(ing|ed|es|s)$/, "");
  if (r.length >= 3) r = r.replace(/e$/, "");
  return r.length >= 3 ? r : w;
}

/** Meaningful words of a text: 4+ letters/digits, no filler, lightly stemmed, unique. */
export function contentWords(text: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeText(text).split(" ")) if (w.length >= 4 && !STOPWORDS.has(w)) out.add(stem(w));
  return [...out];
}

/** An option reduced to what it says: no articles, plurals/tenses folded. "The mitochondria" and "Mitochondria" are the same. */
const optionTokens = (text: string) => new Set(normalizeText(text).split(" ").filter((w) => w && w !== "the" && w !== "an" && w !== "a").map(stem));

function sameOption(a: string, b: string): boolean {
  const x = optionTokens(a);
  const y = optionTokens(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= SIMILAR_OPTIONS;
}

const tokenSet = (text: string) => new Set(normalizeText(text).split(" ").filter(Boolean).map(stem));

/** Share of `words` that appear in `haystack`. An empty list counts as fully covered. */
export function coverage(words: readonly string[], haystack: ReadonlySet<string>): number {
  if (words.length === 0) return 1;
  return words.filter((w) => haystack.has(w)).length / words.length;
}

/** The supplied passage that actually contains this quote (word-for-word, or nearly), or null. */
export function locateEvidence(evidence: string, passages: readonly QualityPassage[], preferKey?: string | null): QualityPassage | null {
  const quote = normalizeText(evidence);
  if (wordCount(quote) < MIN_EVIDENCE_WORDS) return null;
  const ordered = [...passages].sort((a, b) => (a.key === preferKey ? -1 : 0) - (b.key === preferKey ? -1 : 0));
  const quoteTokens = [...tokenSet(quote)];
  for (const p of ordered) {
    const text = normalizeText(p.content);
    if (text.includes(quote)) return p; // word-for-word
    if (coverage(quoteTokens, tokenSet(text)) >= 0.9) return p; // near word-for-word (punctuation, symbols, small slips)
  }
  return null;
}

const fail = (code: QualityCode, reason: string): QualityFailure => ({ code, reason });

export function checkQuality(q: ValidQuestion, ctx: QualityContext): QualityFailure | null {
  const isMcq = q.type === "mcq";

  /* ---- the question itself ---- */
  if (isMcq && wordCount(q.text) < MIN_QUESTION_WORDS) return fail("weak_question", "the question is too short to be clear");
  if (!isMcq) {
    if (wordCount(q.text) < MIN_STATEMENT_WORDS) return fail("weak_question", "the statement is too short to be clear");
    if (/\?\s*$/.test(q.text) || INTERROGATIVE.test(q.text)) return fail("weak_question", "a true/false item must be a statement, not a question");
  }

  /* ---- answer options (multiple choice) ---- */
  if (isMcq) {
    const correct = q.options[q.correctIndex]!;
    const others = q.options.filter((_, i) => i !== q.correctIndex);

    if (q.options.some((o) => wordCount(o) > MAX_OPTION_WORDS)) return fail("options", "an option is a whole paragraph instead of a short answer");
    if (q.options.some((o) => COMBINED_ANSWER.test(o.trim()))) return fail("options", 'combined answers such as "both A and B" make the answer ambiguous');
    if (q.options.some((o) => similarity(o, q.text) >= SIMILAR_OPTIONS && wordCount(o) >= 3)) return fail("options", "an option just repeats the question");

    for (let i = 0; i < q.options.length; i++)
      for (let j = i + 1; j < q.options.length; j++)
        if (sameOption(q.options[i]!, q.options[j]!)) return fail("options", "two options say almost the same thing");

    // The classic giveaway: the right answer is far longer than every wrong one.
    const longestOther = Math.max(...others.map((o) => o.length));
    if (correct.length >= 60 && correct.length >= 3 * longestOther) return fail("options", "the correct answer is obviously longer than the others");
  }

  /* ---- explanation ---- */
  if (q.explanation.length < MIN_EXPLANATION_CHARS) return fail("explanation", "the explanation is too short to teach anything");
  if (q.explanation.length > MAX_EXPLANATION_CHARS) return fail("explanation", "the explanation is too long");
  if (normalizeText(q.explanation) === normalizeText(q.text)) return fail("explanation", "the explanation just repeats the question");
  {
    const anchor = new Set([...contentWords(q.text), ...(isMcq ? contentWords(q.options[q.correctIndex]!) : []), ...contentWords(q.evidence ?? "")]);
    if (!contentWords(q.explanation).some((w) => anchor.has(w))) return fail("explanation", "the explanation does not talk about the question or its answer");
  }

  /* ---- grounding in the notes ---- */
  if (!ctx.grounded || ctx.passages.length === 0) return null;

  const allText = ctx.passages.map((p) => normalizeText(p.content)).join(" \n ");
  if (isMcq) {
    const copied = q.options.filter((o) => wordCount(o) >= 8 && allText.includes(normalizeText(o)));
    if (copied.length >= 2) return fail("options", "the options are whole sentences copied from the notes");
  }

  if (!q.evidence || wordCount(q.evidence) < MIN_EVIDENCE_WORDS) return fail("unsupported", "no quote from the notes supports this question");
  const passage = locateEvidence(q.evidence, ctx.passages, q.sourceKey);
  if (!passage) return fail("unsupported", "the quote given as evidence is not in your notes");

  const evidenceTokens = tokenSet(q.evidence);
  if (isMcq) {
    // The question and the right answer must both be about what the quote says.
    const words = [...new Set([...contentWords(q.text), ...contentWords(q.options[q.correctIndex]!)])];
    if (coverage(words, evidenceTokens) < 0.4) return fail("unsupported", "the question or its answer is not covered by the supporting quote");
    const answerWords = contentWords(q.options[q.correctIndex]!);
    const passageTokens = tokenSet(passage.content);
    const answerSupported = answerWords.length > 0 ? coverage(answerWords, passageTokens) >= 0.6 : normalizeText(passage.content).includes(normalizeText(q.options[q.correctIndex]!));
    if (!answerSupported) return fail("unsupported", "the correct answer does not appear in the notes");
  } else {
    const words = contentWords(q.text);
    if (q.correctIndex === 0) {
      if (coverage(words, evidenceTokens) < 0.6) return fail("statement", "the statement is marked true but the quote does not support it");
    } else {
      if (coverage(words, tokenSet(passage.content)) < 0.5) return fail("unsupported", "the statement is not about anything in the notes");
      if (similarity(q.text, q.evidence) >= 0.9 || normalizeText(q.evidence).includes(normalizeText(q.text))) return fail("statement", "the statement matches the notes word for word but is marked false");
    }
  }
  return null;
}

/** Student-readable names for each kind of rejection, for the "what went wrong" summary. */
export const REJECTION_LABEL: Record<string, string> = {
  structure: "answers or options in the wrong format",
  duplicate: "repeated questions",
  unsupported: "questions not backed by your notes",
  options: "weak or confusing answer options",
  explanation: "explanations that did not fit the question",
  statement: "true/false statements that contradicted the notes",
  weak_question: "unclear questions",
};
