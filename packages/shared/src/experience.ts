import { z } from "zod";

/**
 * STUDENT EXPERIENCE (Phase 12): global search, in-app notifications and "continue learning".
 *
 * Everything here is derived from the student's EXISTING records - nothing is stored for it and nothing calls an AI model.
 * Links are in-app paths only (never `javascript:` or an external URL), so server data can't inject navigation.
 */
export const inAppPathSchema = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[A-Za-z0-9\-_/?=&%.+]*$/, "Must be an in-app path");

/* ----------------------------------------------------------------- search */

export const SEARCH_LIMITS = { minChars: 2, maxChars: 80, perGroup: 5 } as const;

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_LIMITS.minChars, `Type at least ${SEARCH_LIMITS.minChars} characters`)
    .max(SEARCH_LIMITS.maxChars, `Search words can be at most ${SEARCH_LIMITS.maxChars} characters`),
});

const hit = z.object({
  id: z.string().min(1).max(64),
  title: z.string(),
  detail: z.string().nullable(),
  href: inAppPathSchema,
});
export type SearchHit = z.infer<typeof hit>;

export const searchTopicSchema = z.object({ subject: z.string().nullable(), topic: z.string().nullable() });

/** Grouped by what the student is looking for. Each group is limited and only ever holds the student's own records. */
export const searchResponseSchema = z.object({
  query: z.string(),
  documents: z.array(hit),
  quizzes: z.array(hit),
  plans: z.array(hit),
  conversations: z.array(hit),
  /** Subjects and topics the student has already used (quizzes, tutor chats, study plan). */
  topics: z.array(searchTopicSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/* ---------------------------------------------------------- notifications */

export const NOTIFICATION_KINDS = ["session_missed", "session_today", "quiz_result", "viva_result", "recommendation"] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z.object({
  /** Stable for the same thing (e.g. "quiz_result:<attempt id>"), so "read" can be remembered by the browser. */
  id: z.string().min(1).max(100),
  kind: notificationKindSchema,
  /** attention = needs action soon; info = FYI; success = a result. Always also written out in the text. */
  tone: z.enum(["attention", "info", "success"]),
  title: z.string(),
  body: z.string().nullable(),
  href: inAppPathSchema,
  /** When the underlying thing happened (null for "today"/"missed", which have no single time). */
  at: z.string().datetime({ offset: true }).nullable(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  /** True when a part could not be read; what is shown is still real, just possibly incomplete. */
  partial: z.boolean(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

/* ------------------------------------------------------- continue learning */

export const RESUME_KINDS = ["session", "quiz", "viva", "tutor", "note"] as const;
export const resumeItemSchema = z.object({
  kind: z.enum(RESUME_KINDS),
  eyebrow: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  cta: z.string(),
  href: inAppPathSchema,
  /** When the activity was last touched (null for a session planned for today). */
  at: z.string().datetime({ offset: true }).nullable(),
});
export type ResumeItem = z.infer<typeof resumeItemSchema>;
