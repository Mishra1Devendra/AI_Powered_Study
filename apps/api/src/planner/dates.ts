/**
 * Calendar dates as plain "YYYY-MM-DD" strings. All arithmetic is done in UTC on date-only values,
 * so there are no daylight-saving or timezone surprises; the student's timezone is used once, to
 * decide what "today" is for them.
 */

const DAY_MS = 86_400_000;

const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The student's local calendar date right now. Falls back to UTC for an unknown timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export const addDays = (date: string, days: number) => fromUtc(toUtc(date) + days * DAY_MS);

/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(toUtc(date)).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

/** Monday of the week containing `date`. */
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));

/** Every date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
