import { z } from "zod";
import { studySessionSchema } from "./planner.js";

/**
 * Study check: before a study session can be marked complete, the student answers 5 multiple-choice questions about its topic.
 * Passing (at least SESSION_CHECK_PASS correct) completes the session; failing keeps it open and the student can try again with
 * a fresh set. Questions are written by the local AI on the student's click only; grading is done on the server.
 */
export const SESSION_CHECK_QUESTIONS = 5;
export const SESSION_CHECK_PASS = 3;
/** New question sets a student may request for one session per 24 hours (each is one local AI call). */
export const SESSION_CHECK_MAX_PER_DAY = 6;

const uuid = z.string().uuid();

export const sessionCheckStatusSchema = z.enum(["generating", "ready", "passed", "failed", "error"]);
export type SessionCheckStatus = z.infer<typeof sessionCheckStatusSchema>;

/** A question as the student sees it while answering: no answer key. */
export const checkQuestionSchema = z.object({ id: uuid, text: z.string(), options: z.array(z.string()).min(2).max(6) });
export type CheckQuestion = z.infer<typeof checkQuestionSchema>;

/** Shown only AFTER the answers are submitted. */
export const checkReviewItemSchema = z.object({
  questionId: uuid,
  chosen: z.number().int().nullable(),
  correctIndex: z.number().int(),
  explanation: z.string(),
});
export type CheckReviewItem = z.infer<typeof checkReviewItemSchema>;

export const sessionCheckSchema = z.object({
  id: uuid,
  sessionId: uuid,
  status: sessionCheckStatusSchema,
  total: z.number().int(),
  passMark: z.number().int(),
  /** Present while `ready` (to answer) and after submission (to review); null while generating or on error. */
  questions: z.array(checkQuestionSchema).nullable(),
  score: z.number().int().nullable(),
  passed: z.boolean().nullable(),
  review: z.array(checkReviewItemSchema).nullable(),
  /** A student-safe reason when generation failed. */
  error: z.string().nullable(),
  /** True when the labelled demo AI wrote the questions (the local AI was not running). */
  isMock: z.boolean(),
  createdAt: z.string(),
});
export type SessionCheck = z.infer<typeof sessionCheckSchema>;

export const submitCheckInputSchema = z
  .object({ answers: z.array(z.object({ questionId: uuid, choice: z.number().int().min(0).max(5) }).strict()).length(SESSION_CHECK_QUESTIONS, `Answer all ${SESSION_CHECK_QUESTIONS} questions.`) })
  .strict();
export type SubmitCheckInput = z.infer<typeof submitCheckInputSchema>;

/** `check` is null when this session has never been checked. */
export const latestCheckResponseSchema = z.object({ check: sessionCheckSchema.nullable() });
export const startCheckResponseSchema = z.object({ check: sessionCheckSchema });
/** `session` is the updated study session when the check was passed (it is now completed), otherwise null. */
export const submitCheckResponseSchema = z.object({ check: sessionCheckSchema, session: studySessionSchema.nullable() });
export type SubmitCheckResponse = z.infer<typeof submitCheckResponseSchema>;

export const checkParamSchema = z.object({ id: uuid, checkId: uuid });
export const CHECK_REQUIRED_CODE = "check_required";
export const CHECK_REQUIRED_MESSAGE = `To mark this session complete, answer ${SESSION_CHECK_QUESTIONS} short questions about it first.`;
