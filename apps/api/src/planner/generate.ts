import type { PlanInput, PlanProgress } from "@copilot/shared";
import { AIError, type LLMProvider } from "../services/ai/index.js";
import { buildPlannerPrompt } from "../services/ai/planner/prompt.js";
import { daysBetween } from "./dates.js";
import { buildSchedule, studyDates, validateSchedule, type Schedule } from "./schedule.js";
import { parsePlanJson, salvagePlanJson, validateTopicPlan, type TopicPlan } from "./topics.js";

/** A failure whose message is safe to show the student. */
export class PlanGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanGenerationError";
  }
}

/**
 * One topic plan is a short structured answer, but a local model on a modest CPU can still take a few
 * minutes; the tutor's shorter default limit would cut it off.
 */
export const PLAN_CALL_TIMEOUT_MS = 10 * 60_000;

export interface PlanGenerationDeps {
  ai: LLMProvider;
  signal?: AbortSignal;
  onProgress?: (stage: PlanProgress["stage"]) => void;
}

export interface PlanGenerationArgs {
  input: PlanInput;
  startDate: string;
  weakTopics: string[];
}

export interface PlanGenerationResult {
  topicPlan: TopicPlan;
  schedule: Schedule;
  provider: string;
  model: string;
  isMock: boolean;
}

/**
 * Exactly ONE model call per plan: ask for the topics, validate them, then schedule deterministically
 * and check the schedule. No retries and no per-day or per-subject calls.
 */
export async function generatePlan(deps: PlanGenerationDeps, args: PlanGenerationArgs): Promise<PlanGenerationResult> {
  const { input, startDate } = args;
  const report = (s: PlanProgress["stage"]) => deps.onProgress?.(s);

  // Everything that can be checked without the model is checked first, so a hopeless request costs nothing.
  report("preparing");
  const days = studyDates(startDate, input.examDate, input.studyDays);
  if (days.length === 0) throw new PlanGenerationError("There are no study days between today and your exam on the days you chose. Pick more days or a later exam date.");

  report("analyzing");
  const prompt = buildPlannerPrompt({
    subjects: input.subjects,
    level: input.knowledgeLevel,
    minutesPerDay: input.minutesPerDay,
    studyDayCount: days.length,
    daysUntilExam: daysBetween(startDate, input.examDate),
    targetScore: input.targetScore,
    weakTopics: args.weakTopics,
  });
  let result;
  try {
    result = await deps.ai.generateText({
      system: prompt.system,
      messages: prompt.messages,
      json: true,
      temperature: 0.3,
      timeoutMs: PLAN_CALL_TIMEOUT_MS,
      // Generous: JSON mode output is often pretty-printed, and a cut-off reply loses its last topics.
      maxTokens: Math.min(4_000, 450 * input.subjects.length + 400),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    if (deps.signal?.aborted) throw new PlanGenerationError("Creating the plan took too long. Please try again.");
    if (err instanceof AIError) throw new PlanGenerationError(err.message);
    throw err;
  }

  // A reply cut off at the token limit still has usable complete topics: keep those instead of failing.
  const raw = parsePlanJson(result.text) ?? salvagePlanJson(result.text);
  if (raw === null) throw new PlanGenerationError("The local AI's answer could not be read. Nothing was saved. Please try again.");
  let topicPlan: TopicPlan;
  try {
    topicPlan = validateTopicPlan(raw, input.subjects, input.minutesPerDay, input.knowledgeLevel).plan;
  } catch (err) {
    throw new PlanGenerationError(err instanceof Error ? err.message : "The local AI's plan was not usable. Nothing was saved.");
  }

  report("scheduling");
  const weak = new Set(args.weakTopics.map((t) => t.toLowerCase()));
  const priority = new Map(input.subjects.map((s) => [s.name, s.priority]));
  const schedule = buildSchedule({
    startDate,
    examDate: input.examDate,
    studyDays: input.studyDays,
    minutesPerDay: input.minutesPerDay,
    preferredTime: input.preferredTime,
    level: input.knowledgeLevel,
    topics: topicPlan.subjects.flatMap((s) =>
      s.topics.map((t) => ({ subject: s.name, topic: t.topic, minutes: t.minutes, priority: priority.get(s.name) ?? "medium", weak: weak.has(t.topic.toLowerCase()) })),
    ),
  });

  report("checking");
  const problems = validateSchedule(schedule.sessions, { startDate, examDate: input.examDate, minutesPerDay: input.minutesPerDay, subjects: input.subjects.map((s) => s.name) });
  if (problems.length > 0) throw new PlanGenerationError(`The plan did not pass its checks (${problems[0]}). Nothing was saved. Please try again.`);
  if (schedule.sessions.length === 0) throw new PlanGenerationError("No sessions could be scheduled. Pick more study days or more time per day.");

  return { topicPlan, schedule, provider: result.provider, model: result.model, isMock: result.isMock };
}
