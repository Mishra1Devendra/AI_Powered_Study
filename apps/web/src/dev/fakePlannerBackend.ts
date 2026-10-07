import type { ActivityType, PlanInput, PlanOptions, PlanProgress, PlanStats, SessionStatus, StudyPlan, StudySession } from "@copilot/shared";
import { addDays, isoWeekday } from "../features/planner/dates";

/**
 * In-memory stand-in for the study planner API, used by tests and by the DEV-only /dev/study-plan
 * preview. It follows the real server's rules where the UI depends on them: one plan generating at a
 * time, the previous active plan is archived (never deleted), sessions change status only by allowed
 * transitions, and rescheduling keeps the original as history and respects the daily limit.
 * Never bundled into production: its only non-test importer is the lazy, DEV-gated preview page.
 */

export const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface PlannerCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface FakeSession extends Omit<StudySession, "effectiveStatus" | "rescheduledToId"> {}
interface FakePlan extends Omit<StudyPlan, "stats" | "progress"> {
  stage: PlanProgress["stage"] | null;
}

export interface PlannerSeed {
  today?: string;
  mock?: boolean;
  subjects?: string[];
  weakTopics?: PlanOptions["weakTopics"];
  /** "manual": generation waits for `finish()`; "poll": each poll of a generating plan advances one stage. */
  generation?: "manual" | "poll";
}

const STAGES: PlanProgress["stage"][] = ["preparing", "analyzing", "scheduling", "checking", "saving"];
const DEMO_TOPICS = ["Core ideas (demo)", "Key terms (demo)", "Practice problems (demo)"];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, message: string, extra: Record<string, unknown> = {}) => json(status, { error: "error", message, ...extra });

export function makePlannerBackend(seed: PlannerSeed = {}) {
  let today = seed.today ?? "2026-10-05";
  let n = 100;
  const plans: FakePlan[] = [];
  const sessions: FakeSession[] = [];
  const calls: PlannerCall[] = [];
  const mock = seed.mock ?? true;
  const knobs = {
    failNext: null as null | { status: number; message: string; extra?: Record<string, unknown> },
    generationError: null as string | null,
    /** Study check: how many reads show "generating" before the questions are ready (0 = ready at once). */
    checkPolls: 0,
    /** Study check: make the next question set fail to be written. */
    checkError: null as string | null,
  };

  // ---- Study check (5 questions before a session can be completed). The key lives here, like on the server.
  interface FakeCheck {
    id: string;
    sessionId: string;
    status: "generating" | "ready" | "passed" | "failed" | "error";
    polls: number;
    key: number[];
    answers: Record<string, number>;
    score: number | null;
    error: string | null;
    createdAt: string;
  }
  const checks: FakeCheck[] = [];
  let checkN = 0;
  const qid = (c: FakeCheck, i: number) => "00000000-0000-4000-8000-" + String(parseInt(c.id.slice(-4), 10) * 10 + i).padStart(12, "0");
  const checkId = (n: number) => "00000000-0000-4000-9000-" + String(n).padStart(12, "0");
  function toCheck(c: FakeCheck, mock = false) {
    const finished = c.status === "passed" || c.status === "failed";
    const questions = c.status === "ready" || finished ? c.key.map((_, i) => ({ id: qid(c, i), text: "Question " + (i + 1) + " about the topic?", options: ["First option", "Second option", "Third option", "Fourth option"] })) : null;
    return {
      id: c.id,
      sessionId: c.sessionId,
      status: c.status,
      total: 5,
      passMark: 3,
      questions,
      score: c.score,
      passed: finished ? c.status === "passed" : null,
      review: finished ? c.key.map((k, i) => ({ questionId: qid(c, i), chosen: c.answers[qid(c, i)] ?? null, correctIndex: k, explanation: "Because option " + (k + 1) + " is right." })) : null,
      error: c.status === "error" ? c.error : null,
      isMock: mock,
      createdAt: c.createdAt,
    };
  }
  const settle = (c: FakeCheck) => {
    if (c.status !== "generating") return;
    if (c.polls > 0) {
      c.polls--;
      return;
    }
    if (knobs.checkError) {
      Object.assign(c, { status: "error", error: knobs.checkError });
      knobs.checkError = null;
    } else c.status = "ready";
  };

  const effective = (s: FakeSession): SessionStatus => ((s.status === "planned" || s.status === "in_progress") && s.date < today ? "missed" : s.status);
  const toSession = (s: FakeSession): StudySession => ({ ...s, effectiveStatus: effective(s), rescheduledToId: sessions.find((x) => x.rescheduledFromId === s.id)?.id ?? null });
  function stats(planId: string): PlanStats {
    const list = sessions.filter((s) => s.planId === planId && s.status !== "rescheduled");
    return {
      totalSessions: list.length,
      completed: list.filter((s) => s.status === "completed").length,
      skipped: list.filter((s) => s.status === "skipped").length,
      missed: list.filter((s) => effective(s) === "missed").length,
      plannedMinutes: list.reduce((m, s) => m + s.durationMinutes, 0),
      completedMinutes: list.filter((s) => s.status === "completed").reduce((m, s) => m + s.durationMinutes, 0),
    };
  }
  const toPlan = (p: FakePlan): StudyPlan => {
    const { stage, ...rest } = p;
    return { ...rest, stats: stats(p.id), ...(p.status === "generating" && stage ? { progress: { stage } } : {}) };
  };

  function schedule(p: FakePlan) {
    const slots = Math.min(4, Math.max(1, Math.ceil(p.minutesPerDay / 90)));
    const length = Math.min(120, Math.max(15, Math.floor(p.minutesPerDay / slots / 5) * 5));
    const topics = p.subjects.flatMap((s) => (s.topics.length ? s.topics : DEMO_TOPICS).map((t) => ({ subject: s.name, topic: t, priority: s.priority })));
    const kinds: ActivityType[] = ["learn", "practice", "revision", "quiz"];
    let k = 0;
    for (let d = p.startDate; d < p.examDate; d = addDays(d, 1)) {
      if (!p.studyDays.includes(isoWeekday(d))) continue;
      for (let slot = 0; slot < slots; slot++, k++) {
        const t = topics[k % topics.length]!;
        const last = addDays(d, 1) === p.examDate || addDays(d, 2) === p.examDate;
        sessions.push({
          id: pid(++n),
          planId: p.id,
          date: d,
          startTime: p.preferredTime === "any" ? null : `${String({ morning: 8, afternoon: 14, evening: 18 }[p.preferredTime] + slot).padStart(2, "0")}:00`,
          durationMinutes: length,
          subject: t.subject,
          topic: last && slot === 0 ? "Full practice test" : t.topic,
          activityType: last && slot === 0 ? "mock_test" : kinds[Math.floor(k / topics.length) % kinds.length]!,
          priority: t.priority,
          status: "planned",
          startedAt: null,
          completedAt: null,
          rescheduledFromId: null,
        });
      }
    }
  }

  function create(input: PlanInput): FakePlan {
    const p: FakePlan = {
      id: pid(++n),
      ...input,
      startDate: today,
      status: "generating",
      error: null,
      summary: null,
      unscheduledTopics: [],
      weakTopics: (seed.weakTopics ?? []).map((w) => w.topic),
      isMock: mock,
      model: mock ? "mock-demo" : "llama3.2:3b",
      createdAt: new Date(Date.UTC(2026, 9, 5, 9, n % 60)).toISOString(),
      updatedAt: new Date().toISOString(),
      stage: "preparing",
    };
    plans.unshift(p);
    return p;
  }

  /** Completes (or fails) a generating plan, exactly as the server's job would. */
  function finish(planId: string) {
    const p = plans.find((x) => x.id === planId);
    if (!p || p.status !== "generating") return;
    if (knobs.generationError) {
      Object.assign(p, { status: "failed", error: knobs.generationError, stage: null });
      return;
    }
    for (const other of plans) if (other.status === "active") other.status = "archived";
    schedule(p);
    Object.assign(p, { status: "active", stage: null, summary: mock ? "[Demo] Placeholder topics from the offline demo provider, not a real AI." : "Basics first, then practice and revision." });
  }

  function addActivePlan(input: Partial<PlanInput> & { startDate?: string } = {}) {
    const p = create({
      title: "Board exams",
      examDate: addDays(today, 24),
      targetScore: 85,
      minutesPerDay: 120,
      knowledgeLevel: "intermediate",
      subjects: [
        { name: "Physics", priority: "high", topics: ["Kinematics", "Laws of motion", "Work and energy"] },
        { name: "Chemistry", priority: "medium", topics: ["Atomic structure", "Chemical bonding"] },
      ],
      studyDays: [1, 2, 3, 4, 5],
      preferredTime: "evening",
      ...input,
    });
    if (input.startDate) p.startDate = input.startDate;
    finish(p.id);
    return p;
  }

  function fits(p: FakePlan, date: string, minutes: number, ignore: string) {
    const day = sessions.filter((s) => s.planId === p.id && s.date === date && s.id !== ignore && ["planned", "in_progress", "completed"].includes(s.status));
    return day.length < 4 && day.reduce((m, s) => m + s.durationMinutes, 0) + minutes <= p.minutesPerDay;
  }

  async function fetchMock(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;

    if (path === "/api/health") return json(200, { status: "ok", ai: { provider: mock ? "mock" : "ollama", isMock: mock, model: mock ? "mock-demo" : "llama3.2:3b" } });
    if (knobs.failNext) {
      const f = knobs.failNext;
      knobs.failNext = null;
      return fail(f.status, f.message, f.extra);
    }
    if (path === "/api/study-plans/options" && method === "GET") return json(200, { subjects: seed.subjects ?? [], weakTopics: seed.weakTopics ?? [], today, timezone: "UTC" } satisfies PlanOptions);
    if (path === "/api/study-plans" && method === "GET") return json(200, { plans: plans.map(toPlan), activePlanId: plans.find((p) => p.status === "active")?.id ?? null, today });
    if (path === "/api/study-plans/generate" && method === "POST") {
      const busy = plans.find((p) => p.status === "generating");
      if (busy) return fail(409, "A study plan is already being created. Wait for it to finish first.", { planId: busy.id });
      return json(202, { plan: toPlan(create(body as unknown as PlanInput)) });
    }

    let m = /^\/api\/study-plans\/([^/]+)(?:\/(regenerate|activate))?$/.exec(path);
    if (m) {
      const p = plans.find((x) => x.id === m![1]);
      if (!p) return fail(404, "Study plan not found.");
      if (m[2] === "regenerate" && method === "POST") {
        if (plans.some((x) => x.status === "generating")) return fail(409, "A study plan is already being created. Wait for it to finish first.", { planId: plans.find((x) => x.status === "generating")!.id });
        const { title, examDate, targetScore, minutesPerDay, knowledgeLevel, subjects, studyDays, preferredTime } = p;
        return json(202, { plan: toPlan(create({ title, examDate, targetScore, minutesPerDay, knowledgeLevel, subjects, studyDays, preferredTime })) });
      }
      if (m[2] === "activate" && method === "POST") {
        for (const other of plans) if (other.status === "active") other.status = "archived";
        p.status = "active";
        return json(200, { plan: toPlan(p) });
      }
      if (method === "PATCH") {
        if (typeof body?.examDate === "string" && body.examDate <= today) return fail(400, "The exam date must be after today.");
        Object.assign(p, body);
        return json(200, { plan: toPlan(p) });
      }
      if (method === "GET") {
        if (p.status === "generating" && seed.generation === "poll") {
          const i = STAGES.indexOf(p.stage ?? "preparing");
          if (i >= STAGES.length - 1) finish(p.id);
          else p.stage = STAGES[i + 1]!;
        }
        const list = p.status === "generating" || p.status === "failed" ? [] : sessions.filter((s) => s.planId === p.id).sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
        return json(200, { plan: toPlan(p), sessions: list.map(toSession), today, timezone: "UTC" });
      }
    }

    const cm = /^\/api\/study-sessions\/([^/]+)\/check(?:\/([^/]+)\/answers)?$/.exec(path);
    if (cm) {
      const sess = sessions.find((x) => x.id === cm[1]);
      if (!sess) return fail(404, "Study session not found.");
      const mine = checks.filter((c) => c.sessionId === sess.id);
      if (method === "GET") {
        const last = mine[mine.length - 1];
        if (last) settle(last);
        return json(200, { check: last ? toCheck(last, mock) : null });
      }
      if (!cm[2]) {
        const sp = plans.find((x) => x.id === sess.planId)!;
        if (sp.status !== "active") return fail(409, "This plan is not your active plan, so its sessions cannot be changed. Make it active first.");
        if (sess.status !== "planned" && sess.status !== "in_progress") return fail(409, "Only a planned or started session can be checked.");
        const open = mine.find((c) => c.status === "generating" || c.status === "ready");
        if (open) return json(open.status === "generating" ? 202 : 200, { check: toCheck(open, mock) });
        const c: FakeCheck = { id: checkId(++checkN), sessionId: sess.id, status: "generating", polls: knobs.checkPolls, key: [0, 1, 2, 3, 0], answers: {}, score: null, error: null, createdAt: new Date().toISOString() };
        checks.push(c);
        if (knobs.checkPolls === 0) settle(c);
        return json(c.status === "generating" ? 202 : 200, { check: toCheck(c, mock) });
      }
      const c = mine.find((x) => x.id === cm[2]);
      if (!c) return fail(404, "Question set not found.");
      if (c.status !== "ready") return fail(409, "These answers were already submitted. Start a new question set to try again.");
      const given = (body?.answers ?? []) as Array<{ questionId: string; choice: number }>;
      c.answers = Object.fromEntries(given.map((a) => [a.questionId, a.choice]));
      c.score = c.key.filter((k, i) => c.answers[qid(c, i)] === k).length;
      c.status = c.score >= 3 ? "passed" : "failed";
      if (c.status === "passed") Object.assign(sess, { status: "completed", completedAt: new Date().toISOString(), startedAt: sess.startedAt ?? new Date().toISOString() });
      return json(200, { check: toCheck(c, mock), session: c.status === "passed" ? toSession(sess) : null });
    }

    m = /^\/api\/study-sessions\/([^/]+)\/([a-z]+)$/.exec(path);
    if (m && method === "POST") {
      const s = sessions.find((x) => x.id === m![1]);
      if (!s) return fail(404, "Study session not found.");
      const p = plans.find((x) => x.id === s.planId)!;
      if (p.status !== "active") return fail(409, "This plan is not your active plan, so its sessions cannot be changed. Make it active first.");
      const now = new Date().toISOString();
      const ok = () => json(200, { session: toSession(s), created: null });
      switch (m[2]) {
        case "start":
          if (s.status !== "planned") return fail(409, "Only a planned session can be started.");
          Object.assign(s, { status: "in_progress", startedAt: now });
          return ok();
        case "complete":
          // Like the server: completing needs a passed study check, and passing completes the session itself.
          return fail(409, "To mark this session complete, answer 5 short questions about it first.", { error: "check_required" });
        case "skip":
          if (s.status !== "planned" && s.status !== "in_progress") return fail(409, "Only a planned or started session can be skipped.");
          s.status = "skipped";
          return ok();
        case "miss":
          if (s.date >= today) return fail(409, "This session's day has not passed yet, so it is not missed.");
          s.status = "missed";
          return ok();
        case "reschedule": {
          if (!["planned", "in_progress", "skipped", "missed"].includes(s.status)) return fail(409, "This session cannot be rescheduled.");
          let target = typeof body?.date === "string" ? body.date : null;
          if (target) {
            if (target < today) return fail(400, "Pick today or a later date.");
            if (target >= p.examDate) return fail(400, "Pick a date before your exam.");
            if (!fits(p, target, s.durationMinutes, s.id)) return fail(409, `That day has no room for another ${s.durationMinutes}-minute session within your ${p.minutesPerDay} minutes a day.`);
          } else {
            for (let d = s.date >= today ? addDays(s.date, 1) : today; d < p.examDate && !target; d = addDays(d, 1)) if (fits(p, d, s.durationMinutes, s.id)) target = d;
            if (!target) return fail(409, "There is no free time left before your exam for this session. You can keep it as missed instead.");
          }
          s.status = "rescheduled";
          const created: FakeSession = { ...s, id: pid(++n), date: target, startTime: null, status: "planned", startedAt: null, completedAt: null, rescheduledFromId: s.id };
          sessions.push(created);
          return json(200, { session: toSession(s), created: toSession(created) });
        }
      }
      return fail(400, "Unknown action.");
    }
    return fail(404, "Not found.");
  }

  return {
    fetchMock,
    calls,
    plans,
    sessions,
    knobs,
    checks,
    finish,
    addActivePlan,
    setToday: (d: string) => (today = d),
    setStage: (planId: string, stage: PlanProgress["stage"]) => {
      const p = plans.find((x) => x.id === planId);
      if (p) p.stage = stage;
    },
  };
}
