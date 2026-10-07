import type { CardGrade, CardState } from "@copilot/shared";

/**
 * Spaced repetition (a small SM-2 variant). Pure: the same card, grade and time always give the same schedule, so it is
 * easy to test and the browser never decides when a card comes back.
 *
 *  again - forgotten: back in 10 minutes, the interval restarts, ease drops
 *  hard  - remembered with effort: a little longer than last time, ease drops a little
 *  good  - remembered: 1 day, then 3 days, then interval x ease
 *  easy  - effortless: a longer jump, ease rises
 */
export interface CardSchedule {
  easeX100: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
}

export const MIN_EASE = 130;
export const MAX_EASE = 400;
export const MAX_INTERVAL_DAYS = 365;
export const AGAIN_MINUTES = 10;

const DAY_MS = 24 * 60 * 60_000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface Scheduled extends CardSchedule {
  dueAt: Date;
}

export function schedule(card: CardSchedule, grade: CardGrade, now: Date): Scheduled {
  const { easeX100, intervalDays, repetitions, lapses } = card;
  if (grade === "again") {
    return { easeX100: clamp(easeX100 - 20, MIN_EASE, MAX_EASE), intervalDays: 0, repetitions: 0, lapses: lapses + 1, dueAt: new Date(now.getTime() + AGAIN_MINUTES * 60_000) };
  }
  let ease = easeX100;
  let days: number;
  if (grade === "hard") {
    ease = clamp(easeX100 - 15, MIN_EASE, MAX_EASE);
    days = repetitions === 0 ? 1 : Math.max(intervalDays + 1, Math.round(intervalDays * 1.2));
  } else if (grade === "good") {
    days = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(intervalDays + 1, Math.round((intervalDays * ease) / 100));
  } else {
    ease = clamp(easeX100 + 15, MIN_EASE, MAX_EASE);
    days = repetitions === 0 ? 4 : repetitions === 1 ? 6 : Math.max(intervalDays + 2, Math.round(((intervalDays * ease) / 100) * 1.3));
  }
  days = clamp(days, 1, MAX_INTERVAL_DAYS);
  return { easeX100: ease, intervalDays: days, repetitions: repetitions + 1, lapses, dueAt: new Date(now.getTime() + days * DAY_MS) };
}

/** What each answer would do, in days (0 = within minutes). Shown on the answer buttons. */
export function previewDays(card: CardSchedule, now: Date): Record<CardGrade, number> {
  const days = (g: CardGrade) => schedule(card, g, now).intervalDays;
  return { again: days("again"), hard: days("hard"), good: days("good"), easy: days("easy") };
}

/** new: never reviewed. learning: reviewed but not yet remembered (forgotten, due again within minutes). review: on a day-based schedule. */
export function cardState(card: Pick<CardSchedule, "intervalDays"> & { lastReviewedAt: Date | null }): CardState {
  if (!card.lastReviewedAt) return "new";
  return card.intervalDays === 0 ? "learning" : "review";
}
