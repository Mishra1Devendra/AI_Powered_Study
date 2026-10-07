import type { CardGrade, Flashcard } from "@copilot/shared";

/** How long until a card comes back, as a short phrase for the answer buttons ("<10 min", "3 days"). 0 means within minutes. */
export function intervalLabel(days: number): string {
  if (days <= 0) return "<10 min";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return "1 yr";
}

export const GRADES: Array<{ grade: CardGrade; label: string; key: string; hint: string; tone: string }> = [
  { grade: "again", label: "Again", key: "1", hint: "Forgot it", tone: "bg-red-50 text-red-700 ring-red-200 hover:bg-red-100" },
  { grade: "hard", label: "Hard", key: "2", hint: "Remembered with effort", tone: "bg-amber-50 text-amber-800 ring-amber-200 hover:bg-amber-100" },
  { grade: "good", label: "Good", key: "3", hint: "Remembered", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100" },
  { grade: "easy", label: "Easy", key: "4", hint: "Too easy", tone: "bg-sky-50 text-sky-700 ring-sky-200 hover:bg-sky-100" },
];

/** "Due now", "Due in 3 days", "New". Never claims precision a card does not have. */
export function dueLabel(card: Pick<Flashcard, "state" | "dueAt">, now: Date): string {
  if (card.state === "new") return "New";
  const ms = new Date(card.dueAt).getTime() - now.getTime();
  if (ms <= 0) return "Due now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `Due in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Due in ${hours} h`;
  const days = Math.round(hours / 24);
  return `Due in ${days} ${days === 1 ? "day" : "days"}`;
}

export const stateTone: Record<Flashcard["state"], string> = {
  new: "bg-brand-50 text-brand-700 ring-brand-100",
  learning: "bg-amber-50 text-amber-800 ring-amber-200",
  review: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};
