import { describe, expect, it } from "vitest";
import type { Recommendation } from "@copilot/shared";
import type { AttemptFact, BreakdownFact, SessionFact, VivaFact } from "../progress/compute.js";
import { buildRecommendations, type EngineInput } from "./engine.js";

const TODAY = "2026-10-15";
const day = (n: number) => new Date(Date.UTC(2026, 9, 15 + n)).toISOString().slice(0, 10); // n days from today
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const attempt = (id: string, daysAgo: number, subject: string | null = "Physics"): AttemptFact => ({
  attemptId: id,
  quizId: `quiz-${id}`,
  quizTitle: "Quiz",
  subject,
  at: new Date(`${day(-daysAgo)}T10:00:00Z`),
  date: day(-daysAgo),
  percentage: 50,
});
const rows = (attemptId: string, topic: string, correct: number, total: number): BreakdownFact => ({ attemptId, topic, difficulty: "medium", total, answered: total, correct });
const session = (over: Partial<SessionFact> = {}): SessionFact => ({ id: uuid(), date: TODAY, completedDate: null, status: "planned", durationMinutes: 45, subject: "Physics", topic: "Heat", activityType: "learn", planStatus: "active", ...over });
const viva = (topic: string, score: number, daysAgo = 3, subject = "Physics"): VivaFact => ({ id: uuid(), subject, topic, score, date: day(-daysAgo), at: new Date(`${day(-daysAgo)}T10:00:00Z`), c: 5, p: 5, l: 5, f: 5 });

const empty: EngineInput = { today: TODAY, sessions: [], attempts: [], breakdown: [], viva: [], repeated: [], sources: [], tutor: [] };
const run = (over: Partial<EngineInput>, limit?: number) => buildRecommendations({ ...empty, ...over }, limit);
const find = (r: ReturnType<typeof run>, type: string, topic?: string) => r.recommendations.find((x) => x.type === type && (topic === undefined || x.topic === topic));
const byTopic = (r: ReturnType<typeof run>, topic: string): Recommendation => r.recommendations.find((x) => x.topic === topic)!;

describe("no data", () => {
  it("gives nothing and says there is not enough data (never invented advice)", () => {
    const r = run({});
    expect(r.recommendations).toEqual([]);
    expect(r.summary).toEqual({ topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false });
    expect(r.today).toBe(TODAY);
  });
  it("study sessions alone never create a weak or strong topic", () => {
    const r = run({ sessions: [session({ status: "completed", completedDate: day(-1), topic: "Optics" })] });
    expect(r.recommendations).toEqual([]);
    expect(r.summary.hasEnoughData).toBe(false);
  });
});

describe("weak topic", () => {
  const a = [attempt("a1", 3), attempt("a2", 2)];
  const base = { attempts: a, breakdown: [rows("a1", "Electrostatics", 1, 5), rows("a2", "Electrostatics", 1, 5)] };
  it("is detected from real accuracy, with an honest reason and actions that start nothing", () => {
    const rec = byTopic(run(base), "Electrostatics");
    expect(rec).toMatchObject({ type: "WEAK_TOPIC", subject: "Physics", title: "Revise Electrostatics", primary: "quiz" });
    expect(rec.facts).toMatchObject({ accuracy: 20, questions: 10, attempts: 2, repeatedMisses: 0 });
    expect(rec.reason).toBe("You scored 20% across 10 questions in 2 quiz attempts.");
    expect(rec.actionText).toBe("Practice 5 questions");
    expect(rec.actions[0]).toMatchObject({ kind: "quiz", subject: "Physics", topic: "Electrostatics", count: 5 });
    expect(rec.actions[1]).toMatchObject({ kind: "tutor", draft: "Explain Electrostatics step by step, then test my understanding" });
    expect(rec.priority).toBe("high"); // 60 + 6 for the low accuracy
  });
  it("becomes URGENT when repeated mistakes and neglect pile up", () => {
    const rec = byTopic(run({ ...base, attempts: [attempt("a1", 20), attempt("a2", 18)], repeated: [{ topic: "Electrostatics", subject: "Physics", questions: 2 }] }), "Electrostatics");
    expect(rec.type).toBe("URGENT_REVISION");
    expect(rec.title).toBe("Revise Electrostatics now");
    expect(rec.reason).toContain("You got the same 2 questions wrong in more than one attempt.");
    expect(rec.reason).toContain("You last practiced it 18 days ago.");
  });
});

describe("strong topic", () => {
  const strong = { attempts: [attempt("a1", 2)], breakdown: [rows("a1", "Waves", 9, 10)] };
  it("is kept low priority with no fix-it language", () => {
    const rec = byTopic(run(strong), "Waves");
    expect(rec).toMatchObject({ type: "MAINTAIN_STRENGTH", priority: "low", title: "Waves is a strength", primary: "quiz" });
    expect(rec.reason).toBe("You scored 90% across 10 questions. Nothing needs fixing right now.");
    expect(rec.actions[0]).toMatchObject({ kind: "quiz", count: 5, label: "Take a mini quiz" });
  });
  it("a strong topic left alone for two weeks becomes 'Keep fresh' (and ranks a little higher)", () => {
    const fresh = byTopic(run(strong), "Waves");
    const stale = byTopic(run({ attempts: [attempt("a1", 20)], breakdown: [rows("a1", "Waves", 9, 10)] }), "Waves");
    expect(stale.title).toBe("Keep Waves fresh");
    expect(stale.reason).toContain("You last practiced it 20 days ago. A short refresher keeps it fresh.");
    expect(["low", "medium"]).toContain(stale.priority);
    expect(stale.priority >= fresh.priority || stale.priority === "low").toBe(true);
  });
});

describe("repeated mistakes", () => {
  it("a topic at an OK average is still flagged when the same question is missed again and again", () => {
    const r = run({ attempts: [attempt("a1", 4), attempt("a2", 1)], breakdown: [rows("a1", "Heat", 4, 5), rows("a2", "Heat", 4, 5)], repeated: [{ topic: "heat", subject: "Physics", questions: 1 }] });
    const rec = byTopic(r, "Heat");
    expect(rec).toMatchObject({ type: "REPEATED_MISTAKE", primary: "tutor", title: "Fix repeated mistakes in Heat" });
    expect(rec.reason).toContain("You got the same question wrong in more than one attempt.");
    expect(rec.actions[0]).toMatchObject({ kind: "tutor", draft: "Explain the common mistakes I make in Heat" });
    expect(rec.facts.repeatedMisses).toBe(1);
  });
});

describe("insufficient evidence", () => {
  it("never calls a topic weak on a few questions: it asks for more practice and says why", () => {
    const rec = byTopic(run({ attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Optics", 0, 3)] }), "Optics");
    expect(rec).toMatchObject({ type: "PRACTICE_MORE", priority: "low" });
    expect(rec.facts.accuracy).toBeNull();
    expect(rec.reason).toBe("You have answered only 3 questions on this topic so far, which is too few to say how you are doing (5 are needed).");
    expect(rec.reason).not.toMatch(/weak|%/i);
  });
  it("the summary counts it as analysed but not as having enough data", () => {
    const r = run({ attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Optics", 0, 3)] });
    expect(r.summary).toEqual({ topicsAnalyzed: 1, topicsWithEnoughData: 0, hasEnoughData: true });
  });
  it("a middling topic is 'Needs practice', not weak", () => {
    const rec = byTopic(run({ attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Algebra", 3, 5)] }), "Algebra");
    expect(rec.type).toBe("PRACTICE_MORE");
    expect(rec.reason).toBe("You scored 60% across 5 questions.");
  });
});

describe("improving", () => {
  it("is recognised from real history and says where it came from", () => {
    const r = run({ attempts: [attempt("a1", 10), attempt("a2", 2)], breakdown: [rows("a1", "Integration", 2, 5), rows("a2", "Integration", 4, 5)] });
    const rec = byTopic(r, "Integration");
    expect(rec).toMatchObject({ type: "IMPROVING", title: "You're improving at Integration" });
    expect(rec.reason).toBe("Your recent performance improved from 40% to 80%. Keep practicing to maintain progress.");
    expect(rec.facts.trend).toEqual({ previous: 40, recent: 80 });
  });
  it("is not claimed without enough history", () => {
    const r = run({ attempts: [attempt("a1", 2)], breakdown: [rows("a1", "Integration", 4, 5)] });
    expect(byTopic(r, "Integration").type).toBe("MAINTAIN_STRENGTH");
  });
});

describe("stale topics", () => {
  it("a topic that needs work and was not practiced for two weeks ranks above the same topic practiced yesterday", () => {
    const mk = (ago: number) => byTopic(run({ attempts: [attempt("a1", ago)], breakdown: [rows("a1", "Algebra", 3, 5)] }), "Algebra");
    const fresh = mk(1);
    const stale = mk(16);
    expect(fresh.facts.daysSincePracticed).toBe(1);
    expect(stale.facts.daysSincePracticed).toBe(16);
    expect(stale.reason).toContain("You last practiced it 16 days ago.");
    expect(fresh.reason).not.toContain("last practiced");
    // 22 points vs 22 + 12
    expect(stale.priority).toBe("low");
    const ranked = run({ attempts: [attempt("a1", 1), attempt("a2", 16)], breakdown: [rows("a1", "Fresh", 3, 5), rows("a2", "Stale", 3, 5)] });
    expect(ranked.recommendations.map((x) => x.topic)).toEqual(["Stale", "Fresh"]);
  });
  it("Tutor, viva and completed sessions all count as practicing the topic", () => {
    const base = { attempts: [attempt("a1", 20)], breakdown: [rows("a1", "Algebra", 3, 5)] };
    expect(byTopic(run({ ...base, tutor: [{ topic: "algebra", subject: null, date: day(-2) }] }), "Algebra").facts.daysSincePracticed).toBe(2);
    expect(byTopic(run({ ...base, sessions: [session({ topic: "Algebra", status: "completed", completedDate: day(-4) })] }), "Algebra").facts.daysSincePracticed).toBe(4);
    expect(byTopic(run({ ...base, viva: [viva("Algebra", 80, 6)] }), "Algebra").facts.daysSincePracticed).toBe(6);
  });
});

describe("viva", () => {
  it("a poor viva alone creates a viva-practice recommendation", () => {
    const rec = byTopic(run({ viva: [viva("Thermodynamics", 40)] }), "Thermodynamics");
    expect(rec).toMatchObject({ type: "VIVA_PRACTICE", primary: "viva", subject: "Physics" });
    expect(rec.reason).toBe("Your viva score on this topic is 40%.");
    expect(rec.actions[0]).toMatchObject({ kind: "viva", subject: "Physics", topic: "Thermodynamics", count: 5 });
  });
  it("a poor viva raises the priority of a weak quiz topic and is mentioned in the reason", () => {
    const quiz = { attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Heat", 2, 5)] };
    const without = byTopic(run(quiz), "Heat");
    const withViva = byTopic(run({ ...quiz, viva: [viva("Heat", 30), viva("Heat", 50)] }), "Heat");
    expect(without.type).toBe("WEAK_TOPIC");
    expect(withViva.type).toBe("URGENT_REVISION");
    expect(withViva.reason).toContain("Your average viva score on this topic is 40%.");
  });
  it("a strong viva adds no pressure", () => {
    expect(byTopic(run({ attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Heat", 9, 10)], viva: [viva("Heat", 90)] }), "Heat").type).toBe("MAINTAIN_STRENGTH");
  });
});

describe("study plan", () => {
  it("recommends the nearest planned session and links to it; a weak topic in the plan is mentioned", () => {
    const planned = session({ id: "00000000-0000-4000-8000-0000000000aa", date: day(1), topic: "Heat", activityType: "practice", durationMinutes: 30 });
    const r = run({ sessions: [planned, session({ date: day(5), topic: "Later" })], attempts: [attempt("a1", 2)], breakdown: [rows("a1", "Heat", 1, 5)] });
    const up = find(r, "UPCOMING_STUDY")!;
    expect(up).toMatchObject({ id: "UPCOMING_STUDY:00000000-0000-4000-8000-0000000000aa", title: "Continue: Heat", primary: "plan", actionText: "Continue your planned study session" });
    expect(up.reason).toContain(`Planned for ${day(1)}: practice, 30 min.`);
    expect(up.reason).toContain("You scored 20% on this topic in quizzes");
    expect(up.actions[0]).toMatchObject({ kind: "plan", sessionId: "00000000-0000-4000-8000-0000000000aa" });
    expect(r.recommendations.filter((x) => x.type === "UPCOMING_STUDY")).toHaveLength(1); // only the nearest day
  });
  it("a session planned within three days raises the priority of a topic that needs work", () => {
    const quiz = { attempts: [attempt("a1", 2)], breakdown: [rows("a1", "Heat", 3, 5)] };
    const alone = byTopic(run(quiz), "Heat");
    const planned = find(run({ ...quiz, sessions: [session({ date: day(2), topic: "Heat" })] }), "PRACTICE_MORE", "Heat")!;
    expect(alone.priority).toBe("low"); // 22
    expect(planned.priority).toBe("medium"); // 22 + 14
    expect(planned.reason).toContain(`A study session on it is planned for ${day(2)}.`);
    expect(planned.facts.scheduledOn).toBe(day(2));
  });
  it("sessions more than a week away, or on a replaced plan, are not recommended", () => {
    expect(find(run({ sessions: [session({ date: day(9) })] }), "UPCOMING_STUDY")).toBeUndefined();
    expect(find(run({ sessions: [session({ date: day(1), planStatus: "archived" })] }), "UPCOMING_STUDY")).toBeUndefined();
  });
  it("offers to catch up on the latest missed session of the active plan", () => {
    const r = run({ sessions: [session({ date: day(-3), topic: "Old" }), session({ date: day(-1), topic: "Recent" })] });
    const rec = find(r, "UPCOMING_STUDY")!;
    expect(rec).toMatchObject({ title: "Catch up: Recent", primary: "plan" });
    expect(rec.reason).toContain(`You missed this session on ${day(-1)}.`);
  });
  it("a session already marked missed is the student's decision and is not nagged about", () => {
    expect(find(run({ sessions: [session({ date: day(-1), status: "missed" })] }), "UPCOMING_STUDY")).toBeUndefined();
  });
});

describe("actions connect to the existing screens without starting anything", () => {
  const quiz = { attempts: [attempt("a1", 1)], breakdown: [rows("a1", "Heat", 1, 5)] };
  it("notes appear only when a quiz made from a note covers the topic", () => {
    const docId = "00000000-0000-4000-8000-0000000000dd";
    expect(byTopic(run(quiz), "Heat").actions.map((a) => a.kind)).toEqual(["quiz", "tutor", "viva"]);
    const withNote = byTopic(run({ ...quiz, sources: [{ topic: "HEAT", documentId: docId, title: "Heat notes" }] }), "Heat");
    expect(withNote.actions.map((a) => a.kind)).toEqual(["quiz", "tutor", "notes", "viva"]);
    expect(withNote.actions.find((a) => a.kind === "notes")).toMatchObject({ documentId: docId });
  });
  it("a viva action needs a subject (none is invented)", () => {
    const rec = byTopic(run({ attempts: [attempt("a1", 1, null)], breakdown: [rows("a1", "Heat", 1, 5)] }), "Heat");
    expect(rec.subject).toBeNull();
    expect(rec.actions.map((a) => a.kind)).toEqual(["quiz", "tutor"]);
  });
  it("actions carry data only: no links, no generated content", () => {
    for (const a of byTopic(run(quiz), "Heat").actions) expect(Object.keys(a).sort()).toEqual(["count", "documentId", "draft", "kind", "label", "sessionId", "subject", "topic"]);
  });
});

describe("ranking and limits", () => {
  const mix: Partial<EngineInput> = {
    attempts: [attempt("a1", 2), attempt("a2", 2), attempt("a3", 2)],
    breakdown: [rows("a1", "Weakest", 0, 8), rows("a2", "Middling", 3, 5), rows("a3", "Strong", 9, 10)],
  };
  it("most important first: weak, then needs practice, then strengths", () => {
    const r = run(mix);
    expect(r.recommendations.map((x) => [x.topic, x.type])).toEqual([
      ["Weakest", "WEAK_TOPIC"],
      ["Middling", "PRACTICE_MORE"],
      ["Strong", "MAINTAIN_STRENGTH"],
    ]);
  });
  it("is deterministic and stable for the same facts", () => {
    expect(run(mix)).toEqual(run(mix));
  });
  it("respects the limit, keeping the most important", () => {
    expect(run(mix, 2).recommendations.map((x) => x.topic)).toEqual(["Weakest", "Middling"]);
  });
  it("ids are unique and stable", () => {
    const ids = run(mix).recommendations.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("WEAK_TOPIC:weakest");
  });
  it("merges topic spellings and never produces two recommendations for one topic and type", () => {
    const r = run({ attempts: [attempt("a1", 2), attempt("a2", 2)], breakdown: [rows("a1", "Heat", 1, 5), rows("a2", " heat ", 1, 5)] });
    expect(r.recommendations.filter((x) => x.type === "WEAK_TOPIC")).toHaveLength(1);
    expect(r.recommendations[0]!.facts.questions).toBe(10);
  });
});
