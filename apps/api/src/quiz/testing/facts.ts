/**
 * A small, realistic "course" for tests: every fact has a quiz question, the sentence in the notes that
 * supports it, and an explanation. The notes (`FACT_CHUNKS`) are built from exactly those sentences, so
 * a scripted "model" can return questions whose quotes really are in the notes, and the quality gate
 * can be exercised with content that should PASS it as well as content that should not.
 */

export interface McqFact {
  question: string;
  options: [string, string, string, string];
  /** Always option 0 here; tests shuffle where needed. */
  explanation: string;
  evidence: string;
}

export interface TfFact {
  statement: string;
  answer: boolean;
  explanation: string;
  evidence: string;
}

export const MCQ_FACTS: McqFact[] = [
  {
    question: "Which organelle produces most of the ATP a cell uses?",
    options: ["Mitochondria", "Ribosomes", "Lysosomes", "Vacuoles"],
    explanation: "Mitochondria carry out respiration, which makes most of the cell's ATP.",
    evidence: "Mitochondria produce most of the ATP that a cell uses for energy.",
  },
  {
    question: "What do ribosomes build by translating messenger RNA?",
    options: ["Proteins", "Lipids", "Starch", "Nucleotides"],
    explanation: "Ribosomes translate messenger RNA into proteins.",
    evidence: "Ribosomes build proteins by translating messenger RNA in the cytoplasm.",
  },
  {
    question: "Where is the genetic information of a cell stored?",
    options: ["Nucleus", "Ribosome", "Membrane", "Cytoplasm"],
    explanation: "The nucleus holds the genetic information of the cell as DNA.",
    evidence: "The nucleus stores the genetic information of the cell as DNA.",
  },
  {
    question: "What does photosynthesis convert light energy into?",
    options: ["Chemical energy", "Heat", "Sound", "Kinetic energy"],
    explanation: "Photosynthesis stores light energy as chemical energy in glucose.",
    evidence: "Photosynthesis converts light energy into chemical energy stored in glucose.",
  },
  {
    question: "How do enzymes speed up chemical reactions?",
    options: ["By lowering activation energy", "By raising temperature", "By adding water", "By removing oxygen"],
    explanation: "Enzymes lower the activation energy that a reaction needs.",
    evidence: "Enzymes speed up chemical reactions by lowering the activation energy.",
  },
  {
    question: "What is the movement of water across a membrane called?",
    options: ["Osmosis", "Diffusion", "Filtration", "Respiration"],
    explanation: "Osmosis describes water moving across a membrane toward higher solute concentration.",
    evidence: "Osmosis is the movement of water across a membrane from low to high solute concentration.",
  },
  {
    question: "Which law states that energy cannot be created or destroyed?",
    options: ["The first law", "The second law", "Ohm's law", "Hooke's law"],
    explanation: "The first law of thermodynamics is the conservation of energy.",
    evidence: "The first law of thermodynamics states that energy cannot be created or destroyed.",
  },
  {
    question: "What does entropy measure about a macroscopic state?",
    options: ["Number of microscopic arrangements", "Total mass", "Electric charge", "Wave speed"],
    explanation: "Entropy counts the microscopic arrangements behind a macroscopic state.",
    evidence: "Entropy measures how many microscopic arrangements correspond to a macroscopic state.",
  },
  {
    question: "Which kind of heat transfer needs direct contact between particles?",
    options: ["Conduction", "Radiation", "Convection", "Evaporation"],
    explanation: "Conduction passes heat through direct contact between particles.",
    evidence: "Conduction passes heat through direct contact between particles.",
  },
  {
    question: "How does radiation transfer energy without a medium?",
    options: ["As electromagnetic waves", "By moving fluid", "By direct contact", "By sound pressure"],
    explanation: "Radiation moves energy as electromagnetic waves, so it needs no medium.",
    evidence: "Radiation transfers energy as electromagnetic waves and needs no medium.",
  },
  {
    question: "Which process carries heat through the bulk movement of a fluid?",
    options: ["Convection", "Conduction", "Radiation", "Insulation"],
    explanation: "Convection carries heat by the bulk movement of a fluid.",
    evidence: "Convection carries heat through the bulk movement of a fluid.",
  },
  {
    question: "What is the Carnot efficiency of an engine equal to?",
    options: ["One minus cold over hot temperature", "Hot over cold temperature", "Cold minus hot", "Heat divided by work"],
    explanation: "The Carnot efficiency is one minus the ratio of the cold to the hot temperature.",
    evidence: "The Carnot efficiency of an engine is one minus the ratio of cold to hot temperature.",
  },
];

export const TF_FACTS: TfFact[] = [
  {
    statement: "Ribosomes are the site of protein synthesis in the cell.",
    answer: true,
    explanation: "Protein synthesis happens at the ribosomes.",
    evidence: "Ribosomes are the site of protein synthesis in the cell.",
  },
  {
    statement: "Enzymes are consumed by the reactions they catalyse and cannot be reused.",
    answer: false,
    explanation: "Enzymes are not consumed by the reactions they catalyse, so they can be reused.",
    evidence: "Enzymes are not consumed by the reactions they catalyse and can be reused.",
  },
  {
    statement: "Heat flows spontaneously from a hot body to a cold body.",
    answer: true,
    explanation: "Spontaneous heat flow goes from the hot body to the cold body.",
    evidence: "Heat flows spontaneously from a hot body to a cold body, never the other way without work.",
  },
  {
    statement: "Heat flows spontaneously from a cold body to a hot body without any work.",
    answer: false,
    explanation: "Heat cannot flow from cold to hot without work being done.",
    evidence: "Heat flows spontaneously from a hot body to a cold body, never the other way without work.",
  },
  {
    statement: "The entropy of an isolated system never decreases.",
    answer: true,
    explanation: "In an isolated system the entropy does not decrease.",
    evidence: "The entropy of an isolated system never decreases in a spontaneous process.",
  },
  {
    statement: "The entropy of an isolated system always decreases in a spontaneous process.",
    answer: false,
    explanation: "The entropy of an isolated system never decreases, so the statement is wrong.",
    evidence: "The entropy of an isolated system never decreases in a spontaneous process.",
  },
];

/** Six notes sections of ~800 characters. Section k holds MCQ facts 2k and 2k+1 and true/false fact k. */
export const FACT_CHUNKS = Array.from({ length: 6 }, (_, k) => {
  const sentences = [MCQ_FACTS[2 * k]!.evidence, MCQ_FACTS[2 * k + 1]!.evidence, TF_FACTS[k]!.evidence];
  // Neutral padding made of unique made-up tokens, so it can never help a question "match" the notes.
  const padding = Array.from({ length: 70 }, (_, i) => `zzpad${k}x${i}`).join(" ");
  return { text: `${sentences.join(" ")} ${padding}`, page: k + 1, heading: `Heading ${k + 1}` };
});

/** The label of the passage that holds MCQ fact n / TF fact n, when all six sections are supplied in order. */
export const mcqSource = (n: number) => `S${Math.floor(n / 2) + 1}`;
export const tfSource = (n: number) => `S${n + 1}`;

/** What a well-behaved model would return for these facts. `over` lets a test break one thing. */
export function mcqItem(n: number, over: Record<string, unknown> = {}) {
  const f = MCQ_FACTS[n]!;
  return { type: "mcq", question: f.question, options: [...f.options], correctAnswer: 0, explanation: f.explanation, evidence: f.evidence, difficulty: "medium", source: mcqSource(n), ...over };
}

export function tfItem(n: number, over: Record<string, unknown> = {}) {
  const f = TF_FACTS[n]!;
  return { type: "true_false", question: f.statement, correctAnswer: f.answer, explanation: f.explanation, evidence: f.evidence, difficulty: "easy", source: tfSource(n), ...over };
}
