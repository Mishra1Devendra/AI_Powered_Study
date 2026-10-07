import { NO_RELEVANT_MATERIAL_MESSAGE, answerScore, type CreateVivaRequest, type AnswerVivaInput, type SourceMode, type VivaDetail, type VivaListResponse, type VivaOptions, type VivaQuestion, type VivaQuestionSource, type VivaSession } from "@copilot/shared";
import { AppError, ConflictError, NotFoundError } from "../errors.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { LLMProvider } from "../services/ai/index.js";
import type { VivaMaterial } from "../services/ai/viva/prompt.js";
import { evaluateAnswer, generateQuestion, VivaAiError, type Produced } from "./ai.js";
import type { QuestionRecord, SessionRecord, VivaRepository } from "./repository.js";
import { buildResult, overallScore, type AnsweredQuestion } from "./scoring.js";

/** The whole step (question or evaluation, including its one permitted retry) is cut off after this long. */
export const VIVA_STEP_DEADLINE_MS = 10 * 60_000;
const LIST_LIMIT = 50;
/** A follow-up is only offered when the answer was not already strong. */
const FOLLOW_UP_BELOW = 75;

/** What the student asks for. Without a source the viva is "general", exactly as before Phase 11. */
export type StartVivaRequest = CreateVivaRequest;

export interface VivaServiceDeps {
  repo: VivaRepository;
  ai: LLMProvider;
  /** Phase 11: the student's own material, for "My notes" / "Specific document" vivas. */
  knowledge?: KnowledgeService | undefined;
  /** Subjects/topics the student already used (suggestions for the form). */
  topics: (userId: string) => Promise<VivaOptions["topics"]>;
  stepDeadlineMs?: number;
  onError?: (err: unknown) => void;
}

const iso = (d: Date) => d.toISOString();

function toSessionDto(s: SessionRecord): VivaSession {
  return {
    id: s.id,
    subject: s.subject,
    topic: s.topic,
    difficulty: s.difficulty,
    questionCount: s.questionCount,
    status: s.status,
    score: s.score,
    answeredCount: s.answeredCount,
    sourceType: s.sourceType,
    documentId: s.documentId,
    documentTitle: s.documentTitle,
    isMock: s.isMock,
    model: s.model,
    startedAt: iso(s.startedAt),
    completedAt: s.completedAt ? iso(s.completedAt) : null,
  };
}

/** The examiner's key points stay secret until the question has been answered. */
function toQuestionDto(q: QuestionRecord): VivaQuestion {
  return {
    id: q.id,
    number: q.number,
    text: q.text,
    concept: q.concept,
    isFollowUp: q.isFollowUp,
    source: q.sourceRef,
    keyPoints: q.answer ? q.keyPoints : null,
    answer: q.answer ? { ...q.answer, answeredAt: iso(q.answer.answeredAt) } : null,
  };
}

const answeredOnly = (questions: readonly QuestionRecord[]): AnsweredQuestion[] =>
  questions.flatMap((q) => (q.answer ? [{ number: q.number, concept: q.concept, correctness: q.answer.correctness, completeness: q.answer.completeness, clarity: q.answer.clarity, confidence: q.answer.confidence, score: q.answer.score, missingConcepts: q.answer.missingConcepts }] : []));

/**
 * The AI Viva. Each student action makes the fewest model calls it can: starting a viva asks the first question,
 * answering evaluates that one answer, "next" asks the next question. The viva score is calculated here from the
 * validated evaluations - never taken from the model. Only ONE model step runs at a time per student (a second
 * click or tab gets a 409), and nothing runs in the background: every call is a direct reaction to a request.
 */
export function createVivaService(deps: VivaServiceDeps) {
  const { repo, ai } = deps;
  const onError = deps.onError ?? (() => undefined);
  const busy = new Set<string>();

  /** Runs one model step with the per-student guard and a deadline. */
  async function guarded<T>(userId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (busy.has(userId)) throw new AppError(409, "examiner_busy", "The examiner is still working on your previous request. Wait for it to finish.");
    busy.add(userId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.stepDeadlineMs ?? VIVA_STEP_DEADLINE_MS);
    try {
      return await run(controller.signal);
    } catch (err) {
      if (err instanceof VivaAiError) throw new AppError(err.code === "examiner_timeout" ? 504 : 502, err.code, err.message);
      throw err;
    } finally {
      clearTimeout(timer);
      busy.delete(userId);
    }
  }

  type Grounded = { material: VivaMaterial; sourceRef: VivaQuestionSource };

  /**
   * The passage the next question must be based on (null for a general viva). A "My notes" or "Specific document" viva
   * with nothing relevant to ask about is an error the student can act on - never a silent switch to general knowledge.
   */
  async function groundQuestion(
    userId: string,
    session: { sourceType: SourceMode; documentId: string | null; subject: string; topic: string | null },
    number: number,
    exclude: ReadonlyArray<VivaQuestionSource | null>,
  ): Promise<Grounded | null> {
    if (session.sourceType === "general") return null;
    if (!deps.knowledge) throw new AppError(400, "source_unavailable", "Asking about your notes isn't available right now.");
    const chunk = await deps.knowledge.passageForQuestion(userId, {
      documentId: session.sourceType === "document" ? session.documentId : null,
      query: session.topic ?? session.subject,
      number,
      exclude: exclude.flatMap((r) => (r ? [{ documentId: r.documentId, chunkIndex: r.chunkIndex }] : [])),
      requireMatch: session.topic !== null,
    });
    if (!chunk) throw new AppError(422, "no_material", NO_RELEVANT_MATERIAL_MESSAGE);
    return {
      material: { title: chunk.documentTitle, page: chunk.page, heading: chunk.heading, content: chunk.content },
      sourceRef: { documentId: chunk.documentId, documentTitle: chunk.documentTitle, chunkIndex: chunk.chunkIndex, page: chunk.page, heading: chunk.heading },
    };
  }

  /** A question's own passage again (a follow-up probes the previous answer; an evaluation judges against it). Null if it can no longer be read. */
  async function passageOf(userId: string, ref: VivaQuestionSource | null): Promise<Grounded | null> {
    if (!ref || !deps.knowledge) return null;
    const [chunk] = await deps.knowledge.chunksForRefs(userId, [{ documentId: ref.documentId, chunkIndex: ref.chunkIndex }]).catch(() => []);
    return chunk ? { material: { title: chunk.documentTitle, page: chunk.page, heading: chunk.heading, content: chunk.content }, sourceRef: ref } : null;
  }

  async function ownSession(userId: string, id: string) {
    const s = await repo.getSession(userId, id);
    if (!s) throw new NotFoundError("Viva not found.");
    return s;
  }

  async function detail(userId: string, id: string): Promise<VivaDetail> {
    const session = await ownSession(userId, id);
    const questions = await repo.listQuestions(userId, id);
    const result = session.status === "completed" ? buildResult(answeredOnly(questions)) : null;
    return { session: toSessionDto(session), questions: questions.map(toQuestionDto), result };
  }

  const markIfMock = async (userId: string, session: SessionRecord, produced: Produced) => {
    if (produced.isMock && !session.isMock) await repo.markMock(userId, session.id);
  };

  return {
    options: async (userId: string): Promise<VivaOptions> => {
      const [topics, documents] = await Promise.all([deps.topics(userId), deps.knowledge ? deps.knowledge.readyDocuments(userId).catch(() => []) : Promise.resolve([])]);
      return { topics, ...(deps.knowledge ? { documents: documents.map((d) => ({ id: d.id, title: d.title, chunkCount: d.chunkCount })) } : {}) };
    },

    async create(userId: string, input: StartVivaRequest): Promise<VivaDetail> {
      const topic = input.topic?.trim() ? input.topic.trim() : null;
      const sourceType = input.sourceType ?? "general";
      const documentId = sourceType === "document" ? (input.documentId ?? null) : null;
      if (sourceType === "document" && !documentId) throw new AppError(400, "invalid_input", "Choose a document.");
      // Never trust a document id from the client: retrieval only reads this student's own ready documents.
      const grounded = await groundQuestion(userId, { sourceType, documentId, subject: input.subject, topic }, 1, []);
      const first = await guarded(userId, (signal) =>
        generateQuestion(ai, { subject: input.subject, topic, difficulty: input.difficulty, number: 1, total: input.questionCount, asked: [], followUp: null, material: grounded?.material ?? null }, signal),
      );
      const id = await repo.createSession({
        userId,
        subject: input.subject,
        topic,
        difficulty: input.difficulty,
        questionCount: input.questionCount,
        model: first.produced.model,
        isMock: first.produced.isMock,
        sourceType,
        documentId,
        firstQuestion: { text: first.value.question, concept: first.value.concept, keyPoints: first.value.keyPoints, isFollowUp: false, sourceRef: grounded?.sourceRef ?? null },
      });
      return detail(userId, id);
    },

    async list(userId: string): Promise<VivaListResponse> {
      const sessions = await repo.listSessions(userId, LIST_LIMIT);
      const done = sessions.filter((s) => s.status === "completed" && s.score !== null);
      return {
        sessions: sessions.map(toSessionDto),
        summary: { completed: done.length, averageScore: done.length ? Math.round((done.reduce((s, v) => s + v.score!, 0) / done.length) * 10) / 10 : null },
      };
    },

    detail,

    async answer(userId: string, id: string, input: AnswerVivaInput): Promise<VivaDetail> {
      const session = await ownSession(userId, id);
      if (session.status !== "in_progress") throw new ConflictError(session.status === "completed" ? "This viva is already completed." : "This viva was abandoned, so it can't be answered.");
      const questions = await repo.listQuestions(userId, id);
      const target = questions.find((q) => q.id === input.questionId);
      if (!target) throw new NotFoundError("That question isn't part of this viva.");
      if (target.answer) throw new AppError(409, "already_answered", "You already answered this question.");
      const current = questions[questions.length - 1]!;
      if (target.id !== current.id) throw new ConflictError("That is not the current question.");

      // The passage the question was based on is the examiner's (advisory) reference. If it can no longer be read, the answer is judged without it.
      const reference = await passageOf(userId, target.sourceRef);
      const out = await guarded(userId, (signal) =>
        evaluateAnswer(ai, { subject: session.subject, topic: session.topic, difficulty: session.difficulty, question: target.text, keyPoints: target.keyPoints, answer: input.answer, material: reference?.material ?? null }, signal),
      );
      const ev = out.value;
      const score = answerScore(ev);
      const isLast = target.number >= session.questionCount;
      // The viva score is the mean of the answer scores, this one included.
      const complete = isLast ? { score: overallScore([...questions.flatMap((q) => (q.answer ? [q.answer.score] : [])), score]) } : null;
      const saved = await repo.saveAnswer(
        userId,
        id,
        target.id,
        { answerText: input.answer, correctness: ev.correctness, completeness: ev.completeness, clarity: ev.clarity, confidence: ev.confidence, score, feedback: ev.feedback, missingConcepts: ev.missingConcepts, shouldFollowUp: ev.shouldFollowUp },
        complete,
      ).catch((err) => {
        onError(err);
        throw new AppError(500, "save_failed", "We couldn't save your answer. Your text is still here - please try again.");
      });
      if (saved === "duplicate") throw new AppError(409, "already_answered", "You already answered this question.");
      if (saved === "conflict") throw new ConflictError("This viva is no longer in progress.");
      await markIfMock(userId, session, out.produced);
      return detail(userId, id);
    },

    async next(userId: string, id: string): Promise<VivaDetail> {
      const session = await ownSession(userId, id);
      if (session.status !== "in_progress") throw new ConflictError(session.status === "completed" ? "This viva is already completed." : "This viva was abandoned.");
      const questions = await repo.listQuestions(userId, id);
      const last = questions[questions.length - 1]!;
      // Asking again for a question that already exists is harmless: nothing is generated, nothing is duplicated.
      if (!last.answer) return detail(userId, id);
      if (questions.length >= session.questionCount) throw new ConflictError("All the questions have been asked.");

      const followUp = last.answer.shouldFollowUp && !last.isFollowUp && last.answer.score < FOLLOW_UP_BELOW ? { question: last.text, answer: last.answer.answerText, missing: last.answer.missingConcepts } : null;
      const number = questions.length + 1;
      // A follow-up probes the previous answer, so it keeps that question's passage; any other question uses a passage not used yet.
      const grounded = followUp ? await passageOf(userId, last.sourceRef) : await groundQuestion(userId, session, number, questions.map((q) => q.sourceRef));
      const out = await guarded(userId, (signal) =>
        generateQuestion(ai, { subject: session.subject, topic: session.topic, difficulty: session.difficulty, number, total: session.questionCount, asked: questions.map((q) => ({ text: q.text, concept: q.concept })), followUp, material: grounded?.material ?? null }, signal),
      );
      // null = the position was taken meanwhile (a duplicate request): the stored question stands.
      await repo.addQuestion(userId, id, number, { text: out.value.question, concept: out.value.concept, keyPoints: out.value.keyPoints, isFollowUp: followUp !== null, sourceRef: grounded?.sourceRef ?? null });
      await markIfMock(userId, session, out.produced);
      return detail(userId, id);
    },

    async abandon(userId: string, id: string): Promise<VivaDetail> {
      const session = await ownSession(userId, id);
      if (session.status !== "in_progress") throw new ConflictError(session.status === "completed" ? "A completed viva can't be abandoned." : "This viva was already abandoned.");
      if (!(await repo.abandon(userId, id))) throw new ConflictError("This viva is no longer in progress.");
      return detail(userId, id);
    },
  };
}

export type VivaService = ReturnType<typeof createVivaService>;
