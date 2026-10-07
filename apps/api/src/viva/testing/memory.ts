import { randomUUID } from "node:crypto";
import type { SourceMode, VivaDifficulty, VivaStatus } from "@copilot/shared";
import type { AnswerRecord, NewQuestion, QuestionRecord, SessionRecord, VivaRepository } from "../repository.js";

interface SessionRow {
  id: string;
  userId: string;
  subject: string;
  topic: string | null;
  difficulty: VivaDifficulty;
  questionCount: number;
  status: VivaStatus;
  score: number | null;
  model: string | null;
  isMock: boolean;
  sourceType: SourceMode;
  documentId: string | null;
  startedAt: Date;
  completedAt: Date | null;
}
interface QuestionRow extends NewQuestion {
  id: string;
  userId: string;
  sessionId: string;
  number: number;
}
interface AnswerRow extends AnswerRecord {
  userId: string;
  sessionId: string;
  questionId: string;
}

/**
 * In-memory VivaRepository for tests. It mirrors the real one's rules: everything is scoped by user id (another
 * student's id behaves as "not found"), one question per position, one answer per question, an answer and the
 * completion of its viva are saved together, and an abandoned viva cannot be completed.
 */
export function createInMemoryVivaRepository(clock: () => Date = () => new Date()) {
  const sessions: SessionRow[] = [];
  const questions: QuestionRow[] = [];
  const answers: AnswerRow[] = [];
  const knobs = { failSaveAnswer: false };
  /** Document titles by id (the real repository reads them from the documents table). */
  const documentTitles = new Map<string, string>();

  const toSession = (s: SessionRow): SessionRecord => ({
    id: s.id,
    subject: s.subject,
    topic: s.topic,
    difficulty: s.difficulty,
    questionCount: s.questionCount,
    status: s.status,
    score: s.score,
    answeredCount: answers.filter((a) => a.sessionId === s.id).length,
    model: s.model,
    isMock: s.isMock,
    sourceType: s.sourceType,
    documentId: s.documentId,
    documentTitle: s.documentId ? (documentTitles.get(s.documentId) ?? null) : null,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
  });
  const toQuestion = (q: QuestionRow): QuestionRecord => {
    const a = answers.find((x) => x.questionId === q.id);
    return { id: q.id, number: q.number, text: q.text, concept: q.concept, keyPoints: q.keyPoints, isFollowUp: q.isFollowUp, sourceRef: q.sourceRef ?? null, answer: a ? { ...a } : null };
  };

  const repo: VivaRepository = {
    async createSession(input) {
      const id = randomUUID();
      sessions.unshift({ id, userId: input.userId, subject: input.subject, topic: input.topic, difficulty: input.difficulty, questionCount: input.questionCount, status: "in_progress", score: null, model: input.model, isMock: input.isMock, sourceType: input.sourceType, documentId: input.documentId, startedAt: clock(), completedAt: null });
      questions.push({ id: randomUUID(), userId: input.userId, sessionId: id, number: 1, ...input.firstQuestion });
      return id;
    },
    async getSession(userId, id) {
      const s = sessions.find((x) => x.id === id && x.userId === userId);
      return s ? toSession(s) : null;
    },
    async listSessions(userId, limit) {
      return sessions.filter((s) => s.userId === userId).slice(0, limit).map(toSession);
    },
    async listQuestions(userId, sessionId) {
      return questions
        .filter((q) => q.userId === userId && q.sessionId === sessionId)
        .sort((a, b) => a.number - b.number)
        .map(toQuestion);
    },
    async addQuestion(userId, sessionId, number, q) {
      if (!sessions.some((s) => s.id === sessionId && s.userId === userId)) throw new Error("foreign key violation");
      if (questions.some((x) => x.sessionId === sessionId && x.number === number)) return null;
      const row: QuestionRow = { id: randomUUID(), userId, sessionId, number, ...q };
      questions.push(row);
      return toQuestion(row);
    },
    async saveAnswer(userId, sessionId, questionId, a, complete) {
      if (knobs.failSaveAnswer) throw new Error("simulated database failure");
      const q = questions.find((x) => x.id === questionId && x.sessionId === sessionId && x.userId === userId);
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      if (!q || !s) throw new Error("foreign key violation");
      if (answers.some((x) => x.questionId === questionId)) return "duplicate";
      if (complete && s.status !== "in_progress") return "conflict";
      answers.push({ ...a, answeredAt: clock(), userId, sessionId, questionId });
      if (complete) Object.assign(s, { status: "completed", score: complete.score, completedAt: clock() });
      return "saved";
    },
    async markMock(userId, sessionId) {
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      if (s) s.isMock = true;
    },
    async abandon(userId, sessionId) {
      const s = sessions.find((x) => x.id === sessionId && x.userId === userId);
      if (!s || s.status !== "in_progress") return false;
      s.status = "abandoned";
      return true;
    },
  };

  return { repo, knobs, sessions, questions, answers, documentTitles };
}
