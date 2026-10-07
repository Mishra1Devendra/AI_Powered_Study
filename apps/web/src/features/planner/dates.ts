/** Calendar dates as "YYYY-MM-DD" strings, with UTC arithmetic so nothing drifts across timezones. */
const DAY_MS = 86_400_000;
const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDays = (date: string, days: number) => fromUtc(toUtc(date) + days * DAY_MS);
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
/** 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (date: string) => ((new Date(toUtc(date)).getUTCDay() + 6) % 7) + 1;
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts });
const LONG = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const MEDIUM = fmt({ weekday: "short", day: "numeric", month: "short" });
const SHORT = fmt({ day: "numeric", month: "short" });

export const formatLong = (d: string) => LONG.format(toUtc(d));
export const formatMedium = (d: string) => MEDIUM.format(toUtc(d));
export const formatShort = (d: string) => SHORT.format(toUtc(d));

/** "5 – 11 Oct" style label for a week. */
export function weekLabel(start: string) {
  const end = addDays(start, 6);
  return `${formatShort(start)} – ${formatShort(end)}`;
}
