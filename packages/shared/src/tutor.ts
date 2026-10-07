import { z } from "zod";
import { groundingOutcomeSchema, groundingPreferenceSchema } from "./knowledge.js";
import { sourceRefSchema } from "./notes.js";

/** Limits enforced by the API (and mirrored in the UI so students get early feedback). */
export const TUTOR_LIMITS = {
  messageMaxChars: 4000,
  subjectMaxChars: 80,
  topicMaxChars: 120,
  titleMaxChars: 120,
} as const;

export const tutorLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export type TutorLevel = z.infer<typeof tutorLevelSchema>;

export const TUTOR_MODES = [
  "explain_simply",
  "step_by_step",
  "example",
  "hint",
  "test_me",
  "summarize",
  "find_mistake",
  "follow_up",
] as const;
export const tutorModeSchema = z.enum(TUTOR_MODES);
export type TutorMode = z.infer<typeof tutorModeSchema>;

/** UI metadata for each mode. The behaviour itself lives in the API prompt layer. */
export const TUTOR_MODE_INFO: Record<TutorMode, { label: string; hint: string; defaultMessage: string }> = {
  explain_simply: {
    label: "Explain simply",
    hint: "Plain language, no jargon",
    defaultMessage: "Please explain that again, more simply.",
  },
  step_by_step: {
    label: "Step-by-step",
    hint: "Walk through the reasoning",
    defaultMessage: "Please walk me through this step by step.",
  },
  example: {
    label: "Give an example",
    hint: "A concrete worked example",
    defaultMessage: "Can you give me an example?",
  },
  hint: {
    label: "Give me a hint",
    hint: "A nudge, not the answer",
    defaultMessage: "Give me a hint, but not the full answer.",
  },
  test_me: {
    label: "Test me",
    hint: "Ask me a question first",
    defaultMessage: "Test me on this.",
  },
  summarize: {
    label: "Summarize",
    hint: "The key points",
    defaultMessage: "Please summarize the key points so far.",
  },
  find_mistake: {
    label: "Find my mistake",
    hint: "Paste your working",
    defaultMessage: "Here is my attempt. Can you find my mistake?",
  },
  follow_up: {
    label: "Ask a follow-up",
    hint: "Check my understanding",
    defaultMessage: "Ask me a follow-up question to check my understanding.",
  },
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/** Subject / topic / level are all optional and never required to chat. */
export const tutorContextSchema = z.object({
  subject: optionalText(TUTOR_LIMITS.subjectMaxChars),
  topic: optionalText(TUTOR_LIMITS.topicMaxChars),
  level: tutorLevelSchema.nullable().optional(),
});

export const createConversationInputSchema = tutorContextSchema;
export const updateConversationInputSchema = tutorContextSchema.extend({
  title: z.string().trim().min(1).max(TUTOR_LIMITS.titleMaxChars).optional(),
});

export const sendMessageInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Write a message first")
    .max(TUTOR_LIMITS.messageMaxChars, `Messages can be at most ${TUTOR_LIMITS.messageMaxChars} characters`),
  mode: tutorModeSchema.optional(),
  /** Phase 11: ask about ONE of the student's documents. Ownership is verified on the server. */
  documentId: z.string().uuid("Invalid document id").optional(),
  /** "general" = answer from general knowledge, not the student's notes ("Explain generally"). */
  grounding: groundingPreferenceSchema.optional(),
});

export const conversationIdParamSchema = z.object({ id: z.string().uuid("Invalid conversation id") });

export const conversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  subject: z.string().nullable(),
  topic: z.string().nullable(),
  level: tutorLevelSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  mode: tutorModeSchema.nullable(),
  /** AI Notes: the study action this user message requested. */
  action: z.string().nullable().optional(),
  /** AI Notes: the document passages the answer was grounded on (server-built, never model-made). */
  sources: z.array(sourceRefSchema).optional(),
  /** Phase 11: how the answer relates to the student's notes (see knowledge.ts). Absent on older messages. */
  grounding: groundingOutcomeSchema.optional(),
  /** Which model answered (assistant messages). */
  model: z.string().nullable(),
  /** True when the answer came from the demo/mock provider, not a real model. */
  isMock: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});

export const conversationListResponseSchema = z.object({ conversations: z.array(conversationSchema) });
export const conversationResponseSchema = z.object({ conversation: conversationSchema });
export const conversationDetailResponseSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
});

/** Server-sent events emitted while a reply is generated. */
export const tutorStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), message: messageSchema }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), message: messageSchema, conversation: conversationSchema }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

export type Conversation = z.infer<typeof conversationSchema>;
export type TutorMessage = z.infer<typeof messageSchema>;
export type TutorStreamEvent = z.infer<typeof tutorStreamEventSchema>;
export type TutorContextInput = z.infer<typeof tutorContextSchema>;
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
