import { NOT_IN_NOTES_MESSAGE, type Conversation, type GroundingPreference, type SendMessageInput, type SourceRef, type TutorContextInput, type TutorMessage, type TutorStreamEvent } from "@copilot/shared";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { KnowledgeService } from "../knowledge/service.js";
import { groundTutorTurn, outcomeOf, type TutorGrounding } from "./grounding.js";
import type { LLMProvider } from "../services/ai/index.js";
import { collapseRegenerations } from "../services/ai/tutor/history.js";
import { buildTutorPrompt } from "../services/ai/tutor/prompt.js";
import type { TutorRepository } from "./repository.js";
import { DEFAULT_REPLY_DEADLINE_MS, createGenerationLock, createTurn, type Turn } from "./turn.js";

export type { Turn } from "./turn.js";

export const DEFAULT_TITLE = "New conversation";
const LIST_LIMIT = 50;
const DETAIL_MESSAGE_LIMIT = 500;
const HISTORY_FETCH_LIMIT = 100;

export interface TutorServiceOptions {
  repo: TutorRepository;
  ai: LLMProvider;
  /** Phase 11: the student's own material. Without it the tutor works exactly as before (no grounding). */
  knowledge?: KnowledgeService | undefined;
  /** Overridable for tests. */
  replyDeadlineMs?: number;
  onError?: (err: unknown) => void;
}

export function deriveTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 60) return oneLine || DEFAULT_TITLE;
  return `${oneLine.slice(0, 57).trimEnd()}...`;
}

/** Where the previous grounded answer got its passages (for follow-ups), and how it ended. */
function previousGrounding(history: readonly TutorMessage[]): { refs: SourceRef[]; outcome: TutorMessage["grounding"] } {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  return { refs: last?.grounding === "grounded" ? (last.sources ?? []) : [], outcome: last?.grounding };
}

export function createTutorService({ repo, ai, knowledge, replyDeadlineMs = DEFAULT_REPLY_DEADLINE_MS, onError }: TutorServiceOptions) {
  const acquire = createGenerationLock("The tutor is still answering. Please wait a moment.");

  async function requireConversation(userId: string, id: string): Promise<Conversation> {
    // Ownership is enforced twice: the query filters by the verified user id AND RLS applies.
    // A conversation owned by someone else is indistinguishable from one that does not exist.
    const conversation = await repo.getConversation(userId, id);
    if (!conversation) throw new NotFoundError("Conversation not found.");
    return conversation;
  }

  /** Builds a Turn that generates a reply to `current` given prior `history`. */
  function makeTurn(args: {
    userId: string;
    conversation: Conversation;
    studentName: string | null;
    history: TutorMessage[];
    current: { content: string; mode: TutorMessage["mode"] };
    /** Phase 11: the document the student chose to ask about, and whether to skip their notes. */
    scope: { documentId?: string | undefined; preference: GroundingPreference };
    leadingEvent: TutorStreamEvent | null;
    release: () => void;
  }): Turn {
    const { userId, conversation, studentName, history, current, scope, leadingEvent, release } = args;
    let grounding: TutorGrounding = { kind: "none" };
    return createTurn({
      ai,
      replyDeadlineMs,
      onError,
      leadingEvent,
      release,
      buildPrompt: async () => {
        if (knowledge) {
          grounding = await groundTutorTurn({ knowledge, userId, message: current.content, documentId: scope.documentId, preference: scope.preference, previousRefs: previousGrounding(history).refs, onError });
        }
        if (grounding.kind === "not_found") return { fixed: NOT_IN_NOTES_MESSAGE };
        return buildTutorPrompt({
          studentName,
          level: conversation.level,
          subject: conversation.subject,
          topic: conversation.topic,
          mode: current.mode,
          history,
          message: current.content,
          grounding: grounding.kind === "grounded" ? { sources: grounding.sources } : null,
          generalOnly: grounding.kind === "general",
        });
      },
      save: async (reply) => {
        const outcome = outcomeOf(grounding);
        const message = await repo.addAssistantMessage(userId, conversation.id, {
          ...reply,
          ...(grounding.kind === "grounded" ? { sources: grounding.refs } : {}),
          ...(outcome ? { grounding: outcome } : {}),
        });
        const updated = (await repo.getConversation(userId, conversation.id)) ?? conversation;
        return { message, conversation: updated };
      },
    });
  }

  return {
    async createConversation(userId: string, ctx: TutorContextInput): Promise<Conversation> {
      return repo.createConversation(userId, ctx);
    },

    async listConversations(userId: string): Promise<Conversation[]> {
      return repo.listConversations(userId, LIST_LIMIT);
    },

    async getConversationDetail(userId: string, id: string) {
      const conversation = await requireConversation(userId, id);
      const messages = await repo.listMessages(userId, id, DETAIL_MESSAGE_LIMIT);
      return { conversation, messages: collapseRegenerations(messages) };
    },

    async updateConversation(userId: string, id: string, patch: TutorContextInput & { title?: string }) {
      const updated = await repo.updateConversation(userId, id, patch);
      if (!updated) throw new NotFoundError("Conversation not found.");
      return updated;
    },

    async deleteConversation(userId: string, id: string): Promise<void> {
      const ok = await repo.archiveConversation(userId, id);
      if (!ok) throw new NotFoundError("Conversation not found.");
    },

    /** Saves the student's message and returns a Turn that streams the tutor's reply. */
    async startSend(userId: string, id: string, input: SendMessageInput): Promise<Turn> {
      const conversation = await requireConversation(userId, id);
      // Never trust a document id from the client: it must be one of THIS student's ready documents.
      if (input.documentId) {
        if (!knowledge) throw new BadRequestError("Asking about a document isn't available.");
        await knowledge.requireReadyDocument(userId, input.documentId);
      }
      const release = acquire(id);
      try {
        const [studentName, prior] = await Promise.all([
          repo.getStudentName(userId),
          repo.listMessages(userId, id, HISTORY_FETCH_LIMIT),
        ]);
        const mode = input.mode ?? null;
        const userMessage = await repo.addUserMessage(userId, id, { content: input.content, mode });

        let current = conversation;
        if (prior.length === 0 && conversation.title === DEFAULT_TITLE) {
          current = (await repo.updateConversation(userId, id, { title: deriveTitle(input.content) })) ?? conversation;
        }
        return makeTurn({
          userId,
          conversation: current,
          studentName,
          history: prior,
          current: { content: input.content, mode },
          scope: { documentId: input.documentId, preference: input.grounding ?? "auto" },
          leadingEvent: { type: "user_message", message: userMessage },
          release,
        });
      } catch (err) {
        release();
        throw err;
      }
    },

    /**
     * Generates a new reply to the latest student message. Used for "Retry" after a failure
     * and for "Regenerate". Nothing is overwritten: the new reply is appended and supersedes
     * the previous one in the conversation view and in the model's context.
     */
    async startRegenerate(userId: string, id: string): Promise<Turn> {
      const conversation = await requireConversation(userId, id);
      const release = acquire(id);
      try {
        const [studentName, all] = await Promise.all([
          repo.getStudentName(userId),
          repo.listMessages(userId, id, HISTORY_FETCH_LIMIT),
        ]);
        const lastUserIndex = all.map((m) => m.role).lastIndexOf("user");
        if (lastUserIndex === -1) throw new BadRequestError("There is nothing to answer yet.");
        const lastUser = all[lastUserIndex]!;
        // The request that scoped the first answer is not stored on the message, so "Regenerate" keeps its sense from
        // the reply it replaces: a general explanation stays general; a grounded answer stays on its single document.
        const replaced = previousGrounding(all.slice(lastUserIndex + 1));
        const docs = [...new Set(replaced.refs.flatMap((r) => (r.documentId ? [r.documentId] : [])))];
        return makeTurn({
          userId,
          conversation,
          studentName,
          history: all.slice(0, lastUserIndex),
          current: { content: lastUser.content, mode: lastUser.mode },
          scope: { documentId: docs.length === 1 ? docs[0] : undefined, preference: replaced.outcome === "general" ? "general" : "auto" },
          leadingEvent: null,
          release,
        });
      } catch (err) {
        release();
        throw err;
      }
    },
  };
}

export type TutorService = ReturnType<typeof createTutorService>;
