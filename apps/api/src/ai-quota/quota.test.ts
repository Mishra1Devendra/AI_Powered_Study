import { describe, expect, it } from "vitest";
import { AI_COST } from "@copilot/shared";
import { createInMemoryAiUsageRepository } from "./repository.js";
import { createAiQuota } from "./service.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function make(dailyUnits = 10, start = "2026-10-06T21:00:00Z") {
  const clock = { t: new Date(start) };
  const store = createInMemoryAiUsageRepository();
  const quota = createAiQuota({ repo: store.repo, dailyUnits, now: () => new Date(clock.t) });
  return { quota, store, clock };
}

describe("daily AI allowance", () => {
  it("charges each action its cost and lets a student spend exactly their allowance", async () => {
    const { quota } = make(10);
    await quota.charge(A, "student", "quiz"); // 3
    await quota.charge(A, "student", "planner"); // 2
    await quota.charge(A, "student", "tutor"); // 1
    expect(await quota.usage(A, "student")).toMatchObject({ unlimited: false, limit: 10, used: 6, remaining: 4 });
    await quota.charge(A, "student", "quiz"); // 9
    await quota.charge(A, "student", "tutor"); // 10: exactly the allowance
    expect(await quota.usage(A, "student")).toMatchObject({ used: 10, remaining: 0 });
    await expect(quota.charge(A, "student", "tutor")).rejects.toMatchObject({ status: 429, code: "ai_limit_reached" });
  });

  it("refuses an action that does not fit in what is left, without spending anything", async () => {
    const { quota } = make(10);
    for (let i = 0; i < 9; i++) await quota.charge(A, "student", "tutor"); // 9 used, 1 left
    await expect(quota.charge(A, "student", "quiz")).rejects.toMatchObject({ status: 429 });
    expect((await quota.usage(A, "student")).used).toBe(9);
    // a smaller action still fits
    await expect(quota.charge(A, "student", "tutor")).resolves.toBeTruthy();
  });

  it("says plainly what happened, how many uses are left, and when it starts again", async () => {
    const { quota } = make(2, "2026-10-06T21:30:00Z");
    await quota.charge(A, "student", "planner");
    const err = (await quota.charge(A, "student", "quiz").catch((e: unknown) => e)) as { message: string; extra: Record<string, unknown> };
    expect(err.message).toMatch(/reached today's AI limit/);
    expect(err.message).toMatch(/Quiz needs 3 uses, you have 0 left of 2/);
    expect(err.message).toMatch(/starts again in about 3 hours/);
    expect(err.extra).toEqual({ limit: 2, used: 2, remaining: 0, resetsAt: "2026-10-07T00:00:00.000Z" });
  });

  it("an administrator is never limited and never counted", async () => {
    const { quota, store } = make(3);
    for (let i = 0; i < 50; i++) expect(await quota.charge(A, "admin", "quiz")).toBeNull();
    expect(store.counters.size).toBe(0);
    expect(await quota.usage(A, "admin")).toMatchObject({ unlimited: true, limit: null, remaining: null, used: 0 });
  });

  it("each student has their own allowance", async () => {
    const { quota } = make(3);
    await quota.charge(A, "student", "quiz");
    await expect(quota.charge(A, "student", "tutor")).rejects.toMatchObject({ status: 429 });
    await expect(quota.charge(B, "student", "quiz")).resolves.toBeTruthy();
  });

  it("a charge can be given back, never below zero, and only once per charge object use", async () => {
    const { quota } = make(10);
    const charge = await quota.charge(A, "student", "quiz");
    expect((await quota.usage(A, "student")).used).toBe(3);
    await quota.refund(charge);
    expect((await quota.usage(A, "student")).used).toBe(0);
    await quota.refund(charge);
    expect((await quota.usage(A, "student")).used).toBe(0);
    await quota.refund(null);
  });

  it("starts again at midnight UTC", async () => {
    const { quota, clock } = make(3, "2026-10-06T23:59:00Z");
    await quota.charge(A, "student", "quiz");
    await expect(quota.charge(A, "student", "tutor")).rejects.toMatchObject({ status: 429 });
    clock.t = new Date("2026-10-07T00:00:01Z");
    expect(await quota.usage(A, "student")).toMatchObject({ used: 0, remaining: 3 });
    await expect(quota.charge(A, "student", "quiz")).resolves.toBeTruthy();
  });

  it("two requests at once cannot both squeeze under the limit", async () => {
    const { quota } = make(5);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => quota.charge(A, "student", "planner"))); // 2 each
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await quota.usage(A, "student")).used).toBe(4);
  });

  it("an action bigger than the whole allowance can never be paid for", async () => {
    const { quota } = make(2);
    await expect(quota.charge(A, "student", "quiz")).rejects.toMatchObject({ status: 429 });
    expect(AI_COST.quiz).toBeGreaterThan(2);
  });

  it("only the actions that ask the AI cost anything, and bigger jobs cost more than a chat reply", () => {
    expect(AI_COST.tutor).toBe(1);
    expect(AI_COST.quiz).toBeGreaterThan(AI_COST.planner);
    expect(AI_COST.planner).toBeGreaterThan(AI_COST.tutor);
    expect(Object.values(AI_COST).every((n) => Number.isInteger(n) && n >= 1)).toBe(true);
  });
});
