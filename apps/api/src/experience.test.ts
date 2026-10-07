import { describe, expect, it } from "vitest";
import { dashboardSchema, notificationsResponseSchema, resumeItemSchema, searchResponseSchema, type AttemptHistoryItem, type PlanInput } from "@copilot/shared";
import { buildDashboard } from "./dashboard/build-dashboard.js";
import { pickResume, type UnfinishedViva } from "./dashboard/resume.js";
import { createNotificationService, type NotificationSources } from "./notifications/service.js";
import { createPlannerService } from "./planner/service.js";
import { createInMemoryPlannerRepository } from "./planner/testing/memory.js";
import { likePattern } from "./search/repository.js";
import { MockProvider } from "./services/ai/mock-provider.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date(Date.UTC(2026, 9, 5, 12));
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const attempt = (over: Partial<AttemptHistoryItem> = {}): AttemptHistoryItem => ({
  id: ID(1),
  quizId: ID(2),
  quizTitle: "Heat quiz",
  sourceType: "topic",
  sourceLabel: "Physics · Heat",
  difficulty: "easy",
  questionCount: 5,
  status: "submitted",
  startedAt: hoursAgo(5),
  submittedAt: hoursAgo(4),
  score: 4,
  total: 5,
  percentage: 80,
  ...over,
});
const plan = (status: "todo" | "in_progress" | "done", id = "s1") => ({ id, subject: "Physics", topic: "Optics", startTime: null, durationMinutes: 30, status, href: `/study-plan?session=${id}` });
const viva = (over: Partial<UnfinishedViva> = {}): UnfinishedViva => ({ id: ID(9), subject: "Chemistry", topic: "Rates", questionCount: 5, answeredCount: 2, startedAt: hoursAgo(3), ...over });
const activity = (type: "tutor" | "note" | "quiz" | "session", hours: number) => ({ id: `${type}-1`, type, title: `A ${type}`, detail: "d", occurredAt: hoursAgo(hours), href: `/${type}/1` });
const pick = (over: Partial<Parameters<typeof pickResume>[0]> = {}) => pickResume({ plan: [], quizAttempts: [], vivas: [], activity: [], now: NOW, ...over });

describe("continue learning: pickResume (real records only, in priority order)", () => {
  it("nothing to continue -> null (never invented)", () => {
    expect(pick()).toBeNull();
  });

  it("1. a study session in progress beats everything", () => {
    const r = pick({ plan: [plan("todo", "s2"), plan("in_progress", "s1")], quizAttempts: [attempt({ status: "in_progress", submittedAt: null, percentage: null, score: null })], vivas: [viva()], activity: [activity("tutor", 1)] });
    expect(r).toMatchObject({ kind: "session", cta: "Continue session", href: "/study-plan?session=s1" });
    expect(resumeItemSchema.safeParse(r).success).toBe(true);
  });

  it("2. then an unfinished quiz attempt, then 3. an unfinished viva, then 4. today's next session, then 5. recent activity", () => {
    const open = attempt({ id: ID(5), status: "in_progress", submittedAt: null, percentage: null, score: null });
    expect(pick({ quizAttempts: [open], vivas: [viva()], plan: [plan("todo")], activity: [activity("tutor", 1)] })).toMatchObject({ kind: "quiz", href: `/quiz/attempt/${ID(5)}`, title: "Finish Heat quiz" });
    expect(pick({ vivas: [viva({ answeredCount: 2 })], plan: [plan("todo")], activity: [activity("tutor", 1)] })).toMatchObject({ kind: "viva", href: `/viva/${ID(9)}`, detail: "Question 3 of 5" });
    expect(pick({ plan: [plan("todo")], activity: [activity("tutor", 1)] })).toMatchObject({ kind: "session", eyebrow: "Up next today", cta: "Start session" });
    expect(pick({ activity: [activity("tutor", 1)] })).toMatchObject({ kind: "tutor", href: "/tutor/1" });
    expect(pick({ activity: [activity("note", 1)] })).toMatchObject({ kind: "note", cta: "Continue" });
  });

  it("stale or finished things are not 'continue': an old open attempt, an old viva, month-old activity, completed sessions", () => {
    expect(pick({ quizAttempts: [attempt({ status: "in_progress", startedAt: hoursAgo(24 * 5), submittedAt: null, percentage: null, score: null })] })).toBeNull();
    expect(pick({ vivas: [viva({ startedAt: hoursAgo(24 * 10) })] })).toBeNull();
    expect(pick({ activity: [activity("tutor", 24 * 30)] })).toBeNull();
    expect(pick({ plan: [plan("done")] })).toBeNull();
    expect(pick({ quizAttempts: [attempt()] })).toBeNull(); // a finished attempt is a result, not something to resume
  });

  it("the last viva question is never shown as 'question 6 of 5'", () => {
    expect(pick({ vivas: [viva({ answeredCount: 5 })] })?.detail).toBe("Question 5 of 5");
  });

  it("is part of the dashboard payload and stays valid", () => {
    const d = buildDashboard({ displayName: "Rahul", timezone: "UTC" }, { recentConversations: [], unfinishedVivas: [viva()], now: NOW });
    expect(dashboardSchema.parse(d).resume).toMatchObject({ kind: "viva" });
    expect(buildDashboard({ displayName: "Rahul", timezone: "UTC" }).resume).toBeNull();
  });
});

/* ----------------------------------------------------------------------------------------------- */

const rec = (over: Record<string, unknown> = {}) => ({ id: "WEAK_TOPIC:optics", type: "WEAK_TOPIC", priority: "high", title: "Review Optics", reason: "You scored 20%.", ...over }) as NonNullable<Awaited<ReturnType<NotificationSources["topRecommendation"]>>>;
const sources = (over: Partial<NotificationSources> = {}): NotificationSources => ({
  openSessions: async () => null,
  quizAttempts: async () => [],
  vivas: async () => [],
  topRecommendation: async () => null,
  ...over,
});
const session = (n: number, date = "2026-10-05") => ({ id: ID(n), date, subject: "Physics", topic: `Topic ${n}`, durationMinutes: 30, startTime: n === 1 ? "09:30:00" : null });
const service = (over: Partial<NotificationSources> = {}, onError: (e: unknown) => void = () => undefined) => createNotificationService(sources(over), { now: () => NOW, onError });

describe("notifications: derived from real records, nothing invented", () => {
  it("no records -> an empty list (and valid)", async () => {
    const r = await service().list(A);
    expect(r).toEqual({ notifications: [], partial: false });
    expect(notificationsResponseSchema.safeParse(r).success).toBe(true);
  });

  it("missed sessions come first and link to the oldest-unfinished one; today's sessions are listed (max 3)", async () => {
    const r = await service({ openSessions: async () => ({ day: "2026-10-05", missed: [session(7, "2026-10-04"), session(8, "2026-10-02")], today: [session(1), session(2), session(3), session(4)] }) }).list(A);
    expect(r.notifications.map((n) => n.kind)).toEqual(["session_missed", "session_today", "session_today", "session_today"]);
    expect(r.notifications[0]).toMatchObject({ tone: "attention", title: "You have 2 missed study sessions", href: `/study-plan?session=${ID(7)}` });
    expect(r.notifications[1]).toMatchObject({ title: "Today: Topic 1", body: "Physics · 30 min · 09:30" });
  });

  it("one missed session is singular", async () => {
    const r = await service({ openSessions: async () => ({ day: "2026-10-05", missed: [session(7, "2026-10-04")], today: [] }) }).list(A);
    expect(r.notifications[0]!.title).toBe("You have 1 missed study session");
  });

  it("shows only the latest FINISHED quiz and completed viva, and only while they are recent", async () => {
    const fresh = attempt({ id: ID(11) });
    const r = await service({
      quizAttempts: async () => [attempt({ id: ID(10), status: "in_progress", submittedAt: null, percentage: null, score: null }), fresh, attempt({ id: ID(12), submittedAt: hoursAgo(6) })],
      vivas: async () => [
        { id: ID(20), subject: "Chem", topic: null, status: "in_progress", score: null, completedAt: null },
        { id: ID(21), subject: "Chem", topic: "Rates", status: "completed", score: 71.3, completedAt: new Date(NOW.getTime() - 2 * 3600_000) },
      ],
    }).list(A);
    expect(r.notifications.map((n) => n.id)).toEqual([`quiz_result:${ID(11)}`, `viva_result:${ID(21)}`]);
    expect(r.notifications[0]).toMatchObject({ tone: "success", title: "Quiz result: 4/5 (80%)", href: `/quiz/attempt/${ID(11)}/result` });
    expect(r.notifications[1]).toMatchObject({ title: "Viva result: 71%", body: "Rates", href: `/viva/${ID(21)}` });

    const old = await service({ quizAttempts: async () => [attempt({ submittedAt: hoursAgo(24 * 5) })], vivas: async () => [{ id: ID(21), subject: "C", topic: null, status: "completed", score: 90, completedAt: new Date(NOW.getTime() - 24 * 5 * 3600_000) }] }).list(A);
    expect(old.notifications).toEqual([]);
  });

  it("the top recommendation is shown unless it is only praise", async () => {
    expect((await service({ topRecommendation: async () => rec() }).list(A)).notifications[0]).toMatchObject({ kind: "recommendation", tone: "attention", href: "/recommendations", body: "You scored 20%." });
    expect((await service({ topRecommendation: async () => rec({ type: "MAINTAIN_STRENGTH" }) }).list(A)).notifications).toEqual([]);
    expect((await service({ topRecommendation: async () => rec({ priority: "medium" }) }).list(A)).notifications[0]!.tone).toBe("info");
  });

  it("if one part cannot be read, the rest still shows and the answer says 'partial' (no error text leaks)", async () => {
    const errors: unknown[] = [];
    const r = await service(
      {
        openSessions: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        },
        quizAttempts: async () => [attempt()],
      },
      (e: unknown) => void errors.push(e),
    ).list(A);
    expect(r.partial).toBe(true);
    expect(r.notifications.map((n) => n.kind)).toEqual(["quiz_result"]);
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|5432/);
    expect(errors).toHaveLength(1);
  });

  it("every link is an in-app path", async () => {
    const r = await service({
      openSessions: async () => ({ day: "2026-10-05", missed: [session(7, "2026-10-04")], today: [session(1)] }),
      quizAttempts: async () => [attempt()],
      vivas: async () => [{ id: ID(21), subject: "Chem", topic: null, status: "completed", score: 90, completedAt: new Date(NOW.getTime() - 3600_000) }],
      topRecommendation: async () => rec(),
    }).list(A);
    expect(notificationsResponseSchema.safeParse(r).success).toBe(true);
    for (const n of r.notifications) expect(n.href).toMatch(/^\/[^/]/);
  });
});

describe("planner.openSessions (read-only)", () => {
  const input: PlanInput = { title: "Boards", examDate: "2026-11-02", targetScore: null, minutesPerDay: 60, knowledgeLevel: "beginner", subjects: [{ name: "Physics", priority: "high", topics: [] }], studyDays: [1, 2, 3, 4, 5, 6, 7], preferredTime: "any" };

  it("lists today's unfinished sessions, and unfinished sessions of past days as missed; other students see nothing", async () => {
    const mem = createInMemoryPlannerRepository(() => NOW);
    let clock = NOW;
    const planner = createPlannerService({ repo: mem.repo, ai: new MockProvider(0), quizTopics: async () => [], now: () => clock });
    expect(await planner.openSessions(A)).toBeNull(); // no plan, no openSessions
    await planner.generate(A, input);
    await planner.whenIdle();

    const day1 = (await planner.openSessions(A))!;
    expect(day1.day).toBe("2026-10-05");
    expect(day1.today.length).toBeGreaterThan(0);
    expect(day1.today.every((s) => s.date === "2026-10-05")).toBe(true);
    expect(day1.missed).toEqual([]);

    clock = new Date(Date.UTC(2026, 9, 7, 12)); // two days later: day 1's sessions were never finished
    const later = (await planner.openSessions(A))!;
    expect(later.missed.length).toBeGreaterThan(0);
    expect(later.missed.every((s) => s.date < "2026-10-07")).toBe(true);
    expect(later.today.every((s) => s.date === "2026-10-07")).toBe(true);

    expect(await planner.openSessions(B)).toBeNull();
  });
});

describe("search helpers", () => {
  it("treats % _ and the escape character literally", () => {
    expect(likePattern("100%")).toBe("%100!%%");
    expect(likePattern("a_b")).toBe("%a!_b%");
    expect(likePattern("hi!")).toBe("%hi!!%");
  });
  it("a response schema accepts only in-app links", () => {
    const ok = { query: "q", documents: [{ id: "1", title: "T", detail: null, href: "/notes/1" }], quizzes: [], plans: [], conversations: [], topics: [] };
    expect(searchResponseSchema.safeParse(ok).success).toBe(true);
    expect(searchResponseSchema.safeParse({ ...ok, documents: [{ id: "1", title: "T", detail: null, href: "https://evil.example" }] }).success).toBe(false);
    expect(searchResponseSchema.safeParse({ ...ok, documents: [{ id: "1", title: "T", detail: null, href: "javascript:alert(1)" }] }).success).toBe(false);
  });
});
