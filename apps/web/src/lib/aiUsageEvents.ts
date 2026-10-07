/**
 * The moment an AI action happens, the app announces it so the "AI uses left" indicator can refresh at once. The announcement
 * carries no data: the server is the only source of truth for the numbers.
 */
export const AI_USED_EVENT = "copilot:ai-used";

/** The requests that ask the AI for something (the same ones the API charges: see docs/AI_LIMITS.md). Everything else costs nothing. */
const AI_ROUTES: RegExp[] = [
  /^\/api\/tutor\/conversations\/[^/]+\/(messages|regenerate)$/,
  /^\/api\/notes\/[^/]+\/assistant(\/regenerate)?$/,
  /^\/api\/quiz\/(generate|[^/]+\/regenerate)$/,
  /^\/api\/study-plans\/(generate|[^/]+\/regenerate)$/,
  /^\/api\/study-sessions\/[^/]+\/check$/,
  /^\/api\/viva\/sessions(\/[^/]+\/(answer|next))?$/,
  /^\/api\/recommendations\/explain$/,
  /^\/api\/flashcards\/decks\/generate$/,
  /^\/api\/mindmaps\/(generate|[^/]+\/regenerate)$/,
];

export function isAiRequest(method: string | undefined, path: string): boolean {
  if ((method ?? "GET").toUpperCase() !== "POST") return false;
  const clean = path.split("?")[0] ?? path;
  return AI_ROUTES.some((r) => r.test(clean));
}

/** Call after the server has answered a request (any status: a refused or refunded one changes the count too). */
export function announceAiUse(method: string | undefined, path: string): void {
  if (typeof window !== "undefined" && isAiRequest(method, path)) window.dispatchEvent(new Event(AI_USED_EVENT));
}

/** The screens where the indicator is worth the space: the ones that ask the AI for something. */
export function screenUsesAi(pathname: string): boolean {
  if (/^\/quiz\/attempt\//.test(pathname)) return false;
  return /^\/(tutor|viva|flashcards|mindmaps|recommendations|settings|study-plan|quiz)(\/|$)/.test(pathname) || /^\/notes\/[^/]+/.test(pathname);
}
