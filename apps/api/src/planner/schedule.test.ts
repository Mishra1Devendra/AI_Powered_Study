import { describe, expect, it } from "vitest";
import { addDays, daysBetween, isoWeekday, todayIn, weekStart } from "./dates.js";
import { buildSchedule, daySlots, PlanInputError, studyDates, validateSchedule, type ScheduleInput, type TopicItem } from "./schedule.js";

const topic = (subject: string, name: string, over: Partial<TopicItem> = {}): TopicItem => ({ subject, topic: name, minutes: 40, priority: "medium", weak: false, ...over });
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  startDate: "2026-10-05", // a Monday
  examDate: "2026-11-02",
  studyDays: [1, 2, 3, 4, 5],
  minutesPerDay: 120,
  preferredTime: "evening",
  level: "intermediate",
  topics: [topic("Physics", "Kinematics", { priority: "high" }), topic("Physics", "Forces", { priority: "high" }), topic("Chemistry", "Atoms", { priority: "low", weak: true }), topic("Chemistry", "Bonding", { priority: "low" })],
  ...over,
});

const rulesFor = (i: ScheduleInput) => ({ startDate: i.startDate, examDate: i.examDate, minutesPerDay: i.minutesPerDay, subjects: [...new Set(i.topics.map((t) => t.subject))] });

describe("dates", () => {
  it("does calendar arithmetic on plain dates (no timezone drift)", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-05", "2026-11-02")).toBe(28);
    expect(isoWeekday("2026-10-05")).toBe(1);
    expect(isoWeekday("2026-10-11")).toBe(7);
    expect(weekStart("2026-10-08")).toBe("2026-10-05");
  });
  it("computes today in the student's timezone", () => {
    const late = new Date("2026-10-04T20:00:00Z");
    expect(todayIn("UTC", late)).toBe("2026-10-04");
    expect(todayIn("Asia/Kolkata", late)).toBe("2026-10-05");
    expect(todayIn("Not/AZone", late)).toBe("2026-10-04");
  });
});

describe("studyDates and daySlots", () => {
  it("only uses chosen weekdays, from today up to the day before the exam", () => {
    const days = studyDates("2026-10-05", "2026-10-12", [1, 3]);
    expect(days).toEqual(["2026-10-05", "2026-10-07"]);
    expect(studyDates("2026-10-05", "2026-10-05", ALL_DAYS)).toEqual([]);
  });
  it("splits the daily time into at most four sessions", () => {
    expect(daySlots(30)).toEqual({ count: 1, length: 30 });
    expect(daySlots(120)).toEqual({ count: 2, length: 60 });
    expect(daySlots(480).count).toBe(4);
    expect(daySlots(480).length).toBe(120);
  });
});

describe("buildSchedule", () => {
  it("produces a schedule that passes every independent check", () => {
    const i = input();
    const { sessions, unscheduled } = buildSchedule(i);
    expect(sessions.length).toBeGreaterThan(0);
    expect(unscheduled).toEqual([]);
    expect(validateSchedule(sessions, rulesFor(i))).toEqual([]);
  });

  it("never schedules on or after the exam date, or on days the student did not choose", () => {
    const i = input({ studyDays: [2, 4] });
    const { sessions } = buildSchedule(i);
    for (const s of sessions) {
      expect(s.date < i.examDate).toBe(true);
      expect([2, 4]).toContain(isoWeekday(s.date));
    }
  });

  it("respects the daily time limit and the four-sessions-a-day cap", () => {
    for (const minutesPerDay of [30, 45, 60, 120, 180, 300, 480]) {
      const i = input({ minutesPerDay, studyDays: ALL_DAYS });
      const perDay = new Map<string, { m: number; n: number }>();
      for (const s of buildSchedule(i).sessions) {
        const d = perDay.get(s.date) ?? { m: 0, n: 0 };
        perDay.set(s.date, { m: d.m + s.durationMinutes, n: d.n + 1 });
      }
      for (const d of perDay.values()) {
        expect(d.m).toBeLessThanOrEqual(minutesPerDay);
        expect(d.n).toBeLessThanOrEqual(4);
      }
    }
  });

  it("covers every topic with a learn session before revising, and ends with a practice test", () => {
    const { sessions } = buildSchedule(input());
    for (const t of ["Kinematics", "Forces", "Atoms", "Bonding"]) {
      const first = sessions.find((s) => s.topic === t)!;
      expect(first.activityType).toBe("learn");
    }
    expect(sessions.some((s) => s.activityType === "mock_test")).toBe(true);
    expect(sessions.some((s) => s.activityType === "quiz")).toBe(true);
    const mock = sessions.find((s) => s.activityType === "mock_test")!;
    expect(sessions.filter((s) => s.date > mock.date).every((s) => s.activityType === "revision")).toBe(true);
  });

  it("gives weak topics an extra revision", () => {
    const { sessions } = buildSchedule(input());
    const learnPass = (t: string) => sessions.filter((s) => s.topic === t && ["learn", "practice", "revision"].includes(s.activityType)).length;
    expect(learnPass("Atoms")).toBeGreaterThan(learnPass("Bonding"));
  });

  it("starts advanced students on practice instead of learn", () => {
    const { sessions } = buildSchedule(input({ level: "advanced" }));
    expect(sessions.some((s) => s.activityType === "learn")).toBe(false);
  });

  it("uses the preferred time of day, and leaves times open for 'any'", () => {
    expect(buildSchedule(input({ preferredTime: "morning" })).sessions[0]!.startTime).toBe("08:00");
    expect(buildSchedule(input({ preferredTime: "evening" })).sessions[1]!.startTime).toBe("19:10");
    expect(buildSchedule(input({ preferredTime: "any" })).sessions.every((s) => s.startTime === null)).toBe(true);
  });

  it("reports topics that do not fit instead of silently dropping them (low priority first)", () => {
    const many = Array.from({ length: 6 }, (_, k) => topic("Physics", `High ${k}`, { priority: "high" })).concat(Array.from({ length: 6 }, (_, k) => topic("Chemistry", `Low ${k}`, { priority: "low" })));
    const i = input({ startDate: "2026-10-05", examDate: "2026-10-12", studyDays: ALL_DAYS, minutesPerDay: 60, topics: many });
    const { sessions, unscheduled } = buildSchedule(i);
    expect(unscheduled.length).toBeGreaterThan(0);
    expect(unscheduled.every((u) => u.startsWith("Chemistry"))).toBe(true);
    expect(validateSchedule(sessions, rulesFor(i))).toEqual([]);
  });

  it("works with a single study day", () => {
    const i = input({ startDate: "2026-10-05", examDate: "2026-10-06", studyDays: ALL_DAYS, minutesPerDay: 30 });
    const { sessions } = buildSchedule(i);
    expect(sessions).toHaveLength(1);
    expect(validateSchedule(sessions, rulesFor(i))).toEqual([]);
  });

  it("refuses when there are no study days or nothing to schedule", () => {
    expect(() => buildSchedule(input({ startDate: "2026-10-05", examDate: "2026-10-06", studyDays: [3] }))).toThrow(PlanInputError);
    expect(() => buildSchedule(input({ topics: [] }))).toThrow(PlanInputError);
  });

  it("never repeats the same topic and activity on one day, even with one topic", () => {
    const i = input({ topics: [topic("Maths", "Algebra")], minutesPerDay: 480, studyDays: ALL_DAYS });
    const { sessions } = buildSchedule(i);
    expect(validateSchedule(sessions, rulesFor(i))).toEqual([]);
  });
});

describe("validateSchedule", () => {
  const rules = { startDate: "2026-10-05", examDate: "2026-10-20", minutesPerDay: 60, subjects: ["Physics"] };
  const ok = { date: "2026-10-06", startTime: null, durationMinutes: 30, subject: "Physics", topic: "Forces", activityType: "learn" as const, priority: "medium" as const };

  it("accepts a valid session", () => expect(validateSchedule([ok], rules)).toEqual([]));
  it.each([
    ["a date on the exam day", { date: "2026-10-20" }, "on or after the exam"],
    ["a date beyond the exam", { date: "2026-11-01" }, "on or after the exam"],
    ["a date before the plan starts", { date: "2026-10-01" }, "before the plan starts"],
    ["an impossible date", { date: "2026-02-31x" }, "invalid date"],
    ["a too-long session", { durationMinutes: 300 }, "invalid duration"],
    ["a zero-minute session", { durationMinutes: 0 }, "invalid duration"],
    ["an unknown subject", { subject: "History" }, "not one of the plan's subjects"],
    ["an empty topic", { topic: "  " }, "missing topic"],
  ])("rejects %s", (_label, patch, message) => {
    expect(validateSchedule([{ ...ok, ...patch }], rules).join(" ")).toContain(message);
  });
  it("rejects more minutes in a day than the student has", () => {
    expect(validateSchedule([ok, { ...ok, topic: "Energy", durationMinutes: 45 }], rules).join(" ")).toContain("more than the 60 available");
  });
  it("rejects more than four sessions in a day and duplicates", () => {
    const five = Array.from({ length: 5 }, (_, k) => ({ ...ok, topic: `T${k}`, durationMinutes: 15 }));
    expect(validateSchedule(five, { ...rules, minutesPerDay: 480 }).join(" ")).toContain("too many sessions");
    expect(validateSchedule([ok, ok], rules).join(" ")).toContain("duplicate");
  });
});
