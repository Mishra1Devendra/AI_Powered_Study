export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Bounds how much conversation is sent to the model on each turn. */
export const HISTORY_LIMITS = {
  maxMessages: 24,
  maxChars: 28_000,
} as const;

/**
 * Regenerating appends a new assistant message instead of overwriting. When several assistant
 * messages follow the same user message, only the newest is part of the conversation.
 */
export function collapseRegenerations<T extends { role: "user" | "assistant" }>(messages: readonly T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") out[out.length - 1] = m;
    else out.push(m);
  }
  return out;
}

/**
 * Picks the most recent messages that fit the budget. The newest message is always kept.
 * This is the single place to evolve context management later (e.g. replace the dropped
 * prefix with a stored summary) without touching the prompt or the routes.
 */
export function selectHistory<T extends HistoryMessage>(
  messages: readonly T[],
  limits: { maxMessages: number; maxChars: number } = HISTORY_LIMITS,
): { messages: T[]; truncated: boolean } {
  const kept: T[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const over = chars + m.content.length > limits.maxChars || kept.length >= limits.maxMessages;
    if (over && kept.length > 0) break;
    kept.unshift(m);
    chars += m.content.length;
  }
  // A conversation window should start with the student's turn.
  while (kept.length > 1 && kept[0]!.role === "assistant") kept.shift();
  return { messages: kept, truncated: kept.length < messages.length };
}
