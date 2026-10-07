import { describe, expect, it } from "vitest";
import { AGAIN_MINUTES, MAX_EASE, MAX_INTERVAL_DAYS, MIN_EASE, cardState, previewDays, schedule, type CardSchedule } from "./srs.js";

const now = new Date("2026-10-06T10:00:00Z");
const fresh: CardSchedule = { easeX100: 250, intervalDays: 0, repetitions: 0, lapses: 0 };
const days = (d: Date) => (d.getTime() - now.getTime()) / 86_400_000;

describe("spaced repetition schedule", () => {
  it("a new card answered 'good' comes back in 1 day, then 3, then grows by the ease", () => {
    const a = schedule(fresh, "good", now);
    expect([a.intervalDays, a.repetitions, days(a.dueAt)]).toEqual([1, 1, 1]);
    const b = schedule(a, "good", now);
    expect(b.intervalDays).toBe(3);
    const c = schedule(b, "good", now);
    expect(c.intervalDays).toBe(8); // round(3 x 2.5)
    expect(schedule(c, "good", now).intervalDays).toBe(20);
  });

  it("'again' is a lapse: back in 10 minutes, interval and streak restart, ease drops", () => {
    const learned = { easeX100: 250, intervalDays: 12, repetitions: 4, lapses: 1 };
    const s = schedule(learned, "again", now);
    expect(s).toMatchObject({ intervalDays: 0, repetitions: 0, lapses: 2, easeX100: 230 });
    expect(s.dueAt.getTime() - now.getTime()).toBe(AGAIN_MINUTES * 60_000);
  });

  it("'hard' grows slowly and lowers ease; 'easy' jumps further and raises ease", () => {
    const card = { easeX100: 250, intervalDays: 10, repetitions: 3, lapses: 0 };
    const hard = schedule(card, "hard", now);
    const good = schedule(card, "good", now);
    const easy = schedule(card, "easy", now);
    expect(hard.intervalDays).toBe(12);
    expect(hard.easeX100).toBe(235);
    expect(good.intervalDays).toBe(25);
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays);
    expect(easy.easeX100).toBe(265);
    expect(hard.intervalDays).toBeLessThan(good.intervalDays);
  });

  it("every answer moves a due card forward by at least a day (never the same day twice)", () => {
    const card = { easeX100: 130, intervalDays: 1, repetitions: 5, lapses: 0 };
    for (const g of ["hard", "good", "easy"] as const) expect(schedule(card, g, now).intervalDays).toBeGreaterThan(1);
  });

  it("keeps ease and interval inside their limits", () => {
    let c: CardSchedule = { easeX100: MIN_EASE, intervalDays: 3, repetitions: 3, lapses: 0 };
    for (let i = 0; i < 10; i++) c = schedule(c, "again", now);
    expect(c.easeX100).toBe(MIN_EASE);
    c = { easeX100: MAX_EASE, intervalDays: 300, repetitions: 9, lapses: 0 };
    for (let i = 0; i < 5; i++) c = schedule(c, "easy", now);
    expect(c.easeX100).toBe(MAX_EASE);
    expect(c.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });

  it("previews what each button does without changing anything", () => {
    expect(previewDays(fresh, now)).toEqual({ again: 0, hard: 1, good: 1, easy: 4 });
    expect(fresh).toEqual({ easeX100: 250, intervalDays: 0, repetitions: 0, lapses: 0 });
  });

  it("derives the card state", () => {
    expect(cardState({ intervalDays: 0, lastReviewedAt: null })).toBe("new");
    expect(cardState({ intervalDays: 0, lastReviewedAt: now })).toBe("learning");
    expect(cardState({ intervalDays: 4, lastReviewedAt: now })).toBe("review");
  });
});
