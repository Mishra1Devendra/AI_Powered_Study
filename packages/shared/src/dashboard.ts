import { z } from "zod";
import { resumeItemSchema } from "./experience.js";
import { progressSnapshotSchema } from "./progress.js";

/** In-app links only (never `javascript:` or external URLs), so server data can't inject navigation. */
const internalPath = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9\-_/?=&%.]*$/, "Must be an in-app path");

const text = (max: number) => z.string().min(1).max(max);
const percent = z.number().min(0).max(100);
const minutes = z.number().int().min(0).max(24 * 60);
const isoTime = z.string().datetime({ offset: true });

export const planItemSchema = z.object({
  id: text(64),
  subject: text(80),
  topic: text(120),
  /** Local start time "HH:MM", or null for unscheduled tasks. */
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  durationMinutes: z.number().int().min(1).max(600),
  status: z.enum(["todo", "in_progress", "done"]),
  href: internalPath,
});

export const weakTopicSchema = z.object({
  id: text(64),
  subject: text(80),
  topic: text(120),
  status: z.enum(["needs_attention", "improving"]),
  accuracyPercent: percent.nullable(),
  href: internalPath,
});

export const subjectProgressSchema = z.object({
  id: text(64),
  name: text(80),
  progressPercent: percent,
  topicsCompleted: z.number().int().min(0),
  topicsTotal: z.number().int().min(0),
});

export const continueLearningSchema = z.object({
  subject: text(80),
  topic: text(120),
  progressPercent: percent,
  lastStudiedAt: isoTime,
  href: internalPath,
});

export const activityItemSchema = z.object({
  id: text(64),
  type: z.enum(["quiz", "note", "session", "tutor"]),
  title: text(160),
  detail: z.string().max(160).nullable(),
  occurredAt: isoTime,
  href: internalPath.nullable(),
});

/**
 * Today's numbers. `null` means "not tracked yet" (no data source exists or nothing recorded),
 * which the UI renders as an empty state. A real zero is a number. Never fill these with guesses.
 */
export const todaySchema = z.object({
  studyMinutes: minutes.nullable(),
  plannedMinutes: minutes.nullable(),
  tasksCompleted: z.number().int().min(0).nullable(),
  tasksPlanned: z.number().int().min(0).nullable(),
  quizAveragePercent: percent.nullable(),
  streakDays: z.number().int().min(0).nullable(),
});

export const dashboardSchema = z.object({
  profile: z.object({ displayName: z.string(), timezone: z.string() }),
  today: todaySchema,
  continueLearning: continueLearningSchema.nullable(),
  /** Phase 12: the single most useful thing to pick up (an unfinished session / quiz / viva, or recent activity); null when there is none. */
  resume: resumeItemSchema.nullable().optional(),
  plan: z.array(planItemSchema),
  weakTopics: z.array(weakTopicSchema),
  subjects: z.array(subjectProgressSchema),
  activity: z.array(activityItemSchema),
  /** Real numbers from sessions and quiz attempts (last 30 days); null when they could not be read. */
  progress: progressSnapshotSchema.nullable(),
});

export type PlanItem = z.infer<typeof planItemSchema>;
export type WeakTopic = z.infer<typeof weakTopicSchema>;
export type SubjectProgress = z.infer<typeof subjectProgressSchema>;
export type ContinueLearning = z.infer<typeof continueLearningSchema>;
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type Today = z.infer<typeof todaySchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
