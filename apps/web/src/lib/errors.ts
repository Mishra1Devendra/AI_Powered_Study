import { ApiError, NETWORK_MESSAGE } from "./api";

export const GENERIC_LOAD_MESSAGE = "Something went wrong while loading your data. Please try again.";
export const OFFLINE_MESSAGE = "You're offline. Some learning features may be unavailable until your connection returns.";

/**
 * A message that is safe and kind to show a student. Server messages for 4xx errors are already written for students; anything
 * technical (a server fault, a dropped connection, a response the app could not read, an unexpected exception) becomes a plain
 * sentence - never a stack trace, SQL text, host name or library message.
 */
export function friendlyMessage(err: unknown, fallback: string = GENERIC_LOAD_MESSAGE): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return NETWORK_MESSAGE;
    if (err.status === 401) return "Your session has expired. Please sign in again.";
    if (err.status >= 500) return fallback;
    return err.message || fallback;
  }
  return fallback;
}
