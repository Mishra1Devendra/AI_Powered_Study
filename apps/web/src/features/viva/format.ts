import { DIMENSION_LABEL, scoreLevel, SCORE_LEVEL_LABEL, type Dimension, type VivaQuestion, type VivaSession } from "@copilot/shared";

export const pct = (n: number | null) => (n === null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)}%`);
export const outOf100 = (n: number) => `${Math.round(n)} / 100`;
export const levelText = (n: number) => `${SCORE_LEVEL_LABEL[scoreLevel(n)]} — ${Math.round(n)}%`;

export const LEVEL_STYLE = {
  strong: { badge: "bg-emerald-50 text-emerald-800 ring-emerald-200", bar: "#059669", icon: "M3 8.5l3.2 3L13 4.5" },
  developing: { badge: "bg-amber-50 text-amber-900 ring-amber-200", bar: "#d97706", icon: "M3 8h10" },
  weak: { badge: "bg-red-50 text-red-800 ring-red-200", bar: "#dc2626", icon: "M8 3.5v6M8 12v.5" },
} as const;

export const DIMENSION_HINT: Partial<Record<Dimension, string>> = {
  confidence: "An AI estimate of how assured the written answer sounds - not a measurement of you.",
};
export { DIMENSION_LABEL };

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const LONG = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
export const shortDate = (iso: string) => DATE.format(new Date(iso));
export const longDate = (iso: string) => LONG.format(new Date(iso));

export const title = (s: Pick<VivaSession, "subject" | "topic">) => (s.topic ? `${s.subject} — ${s.topic}` : s.subject);

/** The question the student is working on now (the newest one). */
export const currentQuestion = (questions: VivaQuestion[]) => questions[questions.length - 1]!;

/** The prompt handed to the AI Tutor for a concept. Nothing is sent until the student presses send. */
export const tutorDraft = (concept: string, subject: string) => `Explain "${concept}" (${subject}) step by step. I struggled with it in a viva, so test my understanding afterwards.`;

export const DISCLAIMER = "AI-generated evaluation. It is advisory: a small local AI model can misjudge an answer, so treat the scores and feedback as a guide, not a grade.";
