import { z } from "zod";

/** Limits enforced by the API and mirrored in the UI. */
export const PLANNER_LIMITS = {
  titleMaxChars: 100,
  subjectMaxChars: 60,
  topicMaxChars: 80,
  maxSubjects: 8,
  maxTopicsPerSubject: 12,
  minMinutesPerDay: 15,
  maxMinutesPerDay: 480,
  /** Quick choices offered in the form (minutes per day). */
  minutesOptions: [30, 60, 120, 180],
  /** The furthest exam date a plan can cover, in days from today. */
  maxPlanDays: 180,
  minSessionMinutes: 15,
  maxSessionMinutes: 120,
  maxSessionsPerDay: 4,
} as const;

export const KNOWLEDGE_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const knowledgeLevelSchema = z.enum(KNOWLEDGE_LEVELS);
export type KnowledgeLevel = z.infer<typeof knowledgeLevelSchema>;

export const PRIORITIES = ["high", "medium", "low"] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

export const PREFERRED_TIMES = ["morning", "afternoon", "evening", "any"] as const;
export const preferredTimeSchema = z.enum(PREFERRED_TIMES);
export type PreferredTime = z.infer<typeof preferredTimeSchema>;

export const ACTIVITY_TYPES = ["learn", "practice", "quiz", "revision", "mock_test"] as const;
export const activityTypeSchema = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  learn: "Learn",
  practice: "Practice",
  quiz: "Quiz",
  revision: "Revision",
  mock_test: "Practice test",
};

/**
 * Stored statuses. "missed" is only stored when the student chooses "Keep as missed"; a planned
 * session whose date has passed is SHOWN as missed (effectiveStatus) without anything being written.
 * "rescheduled" marks the original of a moved session, which is kept as history.
 */
export const SESSION_STATUSES = ["planned", "in_progress", "completed", "skipped", "missed", "rescheduled"] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const PLAN_STATUSES = ["generating", "active", "archived", "failed"] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof planStatusSchema>;

/** ISO weekdays: 1 = Monday ... 7 = Sunday. */
export const weekdaySchema = z.number().int().min(1).max(7);
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "That date does not exist");

const text = (max: number) => z.string().trim().max(max);

export const planSubjectSchema = z.object({
  name: text(PLANNER_LIMITS.subjectMaxChars).min(1, "Enter a subject name"),
  priority: prioritySchema.default("medium"),
  /** Optional topics the student wants covered; the AI adds to them. */
  topics: z.array(text(PLANNER_LIMITS.topicMaxChars).min(1)).max(PLANNER_LIMITS.maxTopicsPerSubject).default([]),
});
export type PlanSubject = z.infer<typeof planSubjectSchema>;

export const planInputSchema = z.object({
  title: text(PLANNER_LIMITS.titleMaxChars).min(1, "Give your plan a name"),
  /** The exam day itself has no study sessions. Must be after today (checked against the student's timezone). */
  examDate: isoDateSchema,
  targetScore: z.number().int().min(0).max(100).nullable().default(null),
  minutesPerDay: z.number().int().min(PLANNER_LIMITS.minMinutesPerDay, "At least 15 minutes a day").max(PLANNER_LIMITS.maxMinutesPerDay, "At most 8 hours a day"),
  knowledgeLevel: knowledgeLevelSchema,
  subjects: z
    .array(planSubjectSchema)
    .min(1, "Add at least one subject")
    .max(PLANNER_LIMITS.maxSubjects, `At most ${PLANNER_LIMITS.maxSubjects} subjects`)
    .refine((s) => new Set(s.map((x) => x.name.trim().toLowerCase())).size === s.length, "Each subject can only be added once"),
  studyDays: z
    .array(weekdaySchema)
    .min(1, "Choose at least one study day")
    .refine((d) => new Set(d).size === d.length, "Each day can only be chosen once"),
  preferredTime: preferredTimeSchema.default("any"),
});
export type PlanInput = z.infer<typeof planInputSchema>;

export const updatePlanSchema = z
  .object({
    title: text(PLANNER_LIMITS.titleMaxChars).min(1).optional(),
    examDate: isoDateSchema.optional(),
    minutesPerDay: z.number().int().min(PLANNER_LIMITS.minMinutesPerDay).max(PLANNER_LIMITS.maxMinutesPerDay).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const SESSION_ACTIONS = ["start", "complete", "skip", "miss", "reschedule"] as const;
export const sessionActionSchema = z.enum(SESSION_ACTIONS);
export type SessionAction = z.infer<typeof sessionActionSchema>;
export const rescheduleInputSchema = z.object({ date: isoDateSchema.optional() }).default({});

export const planProgressSchema = z.object({
  stage: z.enum(["preparing", "analyzing", "scheduling", "checking", "saving"]),
});
export type PlanProgress = z.infer<typeof planProgressSchema>;

const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

/** Counts from real sessions and real student actions only. */
export const planStatsSchema = z.object({
  totalSessions: z.number().int(),
  completed: z.number().int(),
  skipped: z.number().int(),
  missed: z.number().int(),
  plannedMinutes: z.number().int(),
  completedMinutes: z.number().int(),
});
export type PlanStats = z.infer<typeof planStatsSchema>;

export const studyPlanSchema = z.object({
  id: uuid,
  title: z.string(),
  examDate: isoDateSchema,
  startDate: isoDateSchema,
  targetScore: z.number().int().nullable(),
  minutesPerDay: z.number().int(),
  knowledgeLevel: knowledgeLevelSchema,
  studyDays: z.array(weekdaySchema),
  preferredTime: preferredTimeSchema,
  // Stored subjects are always complete (no defaults), so the response type equals its parsed type.
  subjects: z.array(z.object({ name: z.string(), priority: prioritySchema, topics: z.array(z.string()) })),
  status: planStatusSchema,
  error: z.string().nullable(),
  /** One or two sentences from the AI about the plan (null when none). */
  summary: z.string().nullable(),
  /** Topics that did not fit before the exam, so the student knows (never silently dropped). */
  unscheduledTopics: z.array(z.string()),
  /** Weak topics from the student's real quiz results that the plan gives extra revision. */
  weakTopics: z.array(z.string()),
  isMock: z.boolean(),
  model: z.string().nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
  stats: planStatsSchema,
  progress: planProgressSchema.nullish(),
});
export type StudyPlan = z.infer<typeof studyPlanSchema>;

export const studySessionSchema = z.object({
  id: uuid,
  planId: uuid,
  date: isoDateSchema,
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  durationMinutes: z.number().int(),
  subject: z.string(),
  topic: z.string(),
  activityType: activityTypeSchema,
  priority: prioritySchema,
  status: sessionStatusSchema,
  /** What to show: a planned session whose date has passed is "missed" (nothing is written for that). */
  effectiveStatus: sessionStatusSchema,
  startedAt: isoTime.nullable(),
  completedAt: isoTime.nullable(),
  rescheduledFromId: uuid.nullable(),
  rescheduledToId: uuid.nullable(),
});
export type StudySession = z.infer<typeof studySessionSchema>;

export const planDetailResponseSchema = z.object({
  plan: studyPlanSchema,
  sessions: z.array(studySessionSchema),
  /** The student's local date, so the UI and server agree on "today". */
  today: isoDateSchema,
  timezone: z.string(),
});
export type PlanDetailResponse = z.infer<typeof planDetailResponseSchema>;

export const planListResponseSchema = z.object({
  plans: z.array(studyPlanSchema),
  activePlanId: uuid.nullable(),
  today: isoDateSchema,
});
export type PlanListResponse = z.infer<typeof planListResponseSchema>;

export const planOptionsSchema = z.object({
  /** Subject names the student has already used elsewhere in the app (suggestions only). */
  subjects: z.array(z.string()),
  /** Real quiz topics with low accuracy (at least 3 answered questions). Empty when there are none. */
  weakTopics: z.array(z.object({ topic: z.string(), correct: z.number().int(), total: z.number().int(), percentage: z.number() })),
  today: isoDateSchema,
  timezone: z.string(),
});
export type PlanOptions = z.infer<typeof planOptionsSchema>;

export const sessionActionResponseSchema = z.object({
  session: studySessionSchema,
  /** The new session created by a reschedule. */
  created: studySessionSchema.nullable(),
});
export type SessionActionResponse = z.infer<typeof sessionActionResponseSchema>;

export const planResponseSchema = z.object({ plan: studyPlanSchema });
export const planIdParamSchema = z.object({ id: uuid });
export const sessionActionParamSchema = z.object({ id: uuid, action: sessionActionSchema });
