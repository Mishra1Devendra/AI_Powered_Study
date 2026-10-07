import { useSyncExternalStore } from "react";
import type { ResumeItem } from "@copilot/shared";

/**
 * "Continue learning" is worked out by the API as part of the dashboard (no extra request, nothing stored). The dashboard
 * hands it to this tiny in-memory holder so other screens (the sidebar, the module pages) can offer the same shortcut
 * WITHOUT fetching again. It forgets itself after a few minutes and for any other signed-in student.
 */
const MAX_AGE_MS = 10 * 60_000;

interface Held {
  userId: string;
  resume: ResumeItem | null;
  at: number;
}
let held: Held | null = null;
const listeners = new Set<() => void>();

export function setResume(userId: string, resume: ResumeItem | null, now = Date.now()) {
  held = { userId, resume, at: now };
  listeners.forEach((l) => l());
}

export function clearResume() {
  held = null;
  listeners.forEach((l) => l());
}

export const readResume = (userId: string | undefined, now = Date.now()): ResumeItem | null => (held && userId && held.userId === userId && now - held.at <= MAX_AGE_MS ? held.resume : null);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The student's current "continue" shortcut, if the dashboard has loaded it recently. */
export function useStoredResume(userId: string | undefined): ResumeItem | null {
  return useSyncExternalStore(
    subscribe,
    () => readResume(userId),
    () => null,
  );
}
