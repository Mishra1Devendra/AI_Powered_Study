import type { AttemptStatus, Difficulty, QuestionDifficulty, Quiz, QuizStatus } from "@copilot/shared";

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard", mixed: "Mixed" };
export const QUESTION_DIFFICULTY_LABEL: Record<QuestionDifficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export const QUIZ_STATUS_INFO: Record<QuizStatus, { label: string; classes: string }> = {
  generating: { label: "Creating", classes: "bg-amber-50 text-amber-900 ring-amber-200" },
  ready: { label: "Ready", classes: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  failed: { label: "Failed", classes: "bg-red-50 text-red-800 ring-red-200" },
};

export const ATTEMPT_STATUS_LABEL: Record<AttemptStatus, string> = { in_progress: "In progress", submitted: "Completed", expired: "Time ran out" };

/** "7 min 05 s", "45 s", "1 h 02 min". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** Countdown clock: "09:41", "1:02:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const formatPercent = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

export const isGenerating = (q: Pick<Quiz, "status">) => q.status === "generating";

/** Plain-language band for a score. Colour is never the only signal: the label is always shown. */
export function scoreBand(percentage: number): { label: string; classes: string } {
  if (percentage >= 80) return { label: "Strong", classes: "text-emerald-700" };
  if (percentage >= 50) return { label: "Getting there", classes: "text-amber-700" };
  return { label: "Needs practice", classes: "text-red-700" };
}

export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

/** The text the "Ask AI to explain" action drops into the tutor's message box. Built only from the question's own data. */
export function explainPrompt(item: {
  text: string;
  options: string[];
  selected: number | null;
  correctAnswer: number;
  explanation: string;
  topic?: string | null;
  source?: { evidence?: string | null } | null;
}): string {
  const choice = (i: number | null) => (i === null ? "I skipped it" : `${OPTION_LETTERS[i]}. ${item.options[i]}`);
  return [
    "I got this quiz question wrong. Please help me understand it.",
    "",
    `Question: ${item.text}`,
    ...item.options.map((o, i) => `${OPTION_LETTERS[i]}. ${o}`),
    "",
    `My answer: ${choice(item.selected)}`,
    `Correct answer: ${choice(item.correctAnswer)}`,
    `The quiz's explanation: ${item.explanation}`,
    ...(item.source?.evidence ? [`The sentence from my notes it is based on: "${item.source.evidence}"`] : []),
    ...(item.topic ? [`Topic: ${item.topic}`] : []),
    "",
    "Explain why the correct answer is right and why my answer is not, in simple terms.",
  ].join("\n");
}
