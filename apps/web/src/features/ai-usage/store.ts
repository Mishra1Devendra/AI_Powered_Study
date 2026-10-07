import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useSyncExternalStore } from "react";
import type { AiUsage } from "@copilot/shared";
import { fetchAiUsage } from "../../lib/api";
import { AI_USED_EVENT } from "../../lib/aiUsageEvents";

/**
 * One live copy of today's AI allowance, shared by the top-bar indicator and the notes next to the AI buttons. It refreshes
 *  - at once when the app says an AI action happened (AI_USED_EVENT, a moment later so the server has finished charging),
 *  - when the student returns to the tab,
 *  - and once a minute while the tab is visible (another tab or device may have used some),
 * and only while something is showing it. The numbers always come from the server.
 */
export type UsageState = { status: "loading" } | { status: "error" } | { status: "ready"; usage: AiUsage };

const POLL_MS = 60_000;
const SETTLE_MS = 250;

let state: UsageState = { status: "loading" };
let client: SupabaseClient | null = null;
let subscribers = 0;
let seq = 0;
let inflight: Promise<void> | null = null;
let settle: ReturnType<typeof setTimeout> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const set = (next: UsageState) => {
  state = next;
  emit();
};

export function refreshAiUsage(force = false): Promise<void> {
  // Two components mounting together share one request; a refresh after an AI action always asks again (the old answer is stale).
  if (inflight && !force) return inflight;
  const p = load();
  inflight = p;
  void p.finally(() => {
    if (inflight === p) inflight = null;
  });
  return p;
}

async function load(): Promise<void> {
  const c = client;
  if (!c) return;
  const mine = ++seq;
  try {
    const usage = await fetchAiUsage(c);
    // An older answer must never overwrite a newer one, nor one for a different account.
    if (mine === seq && c === client) set({ status: "ready", usage });
  } catch {
    // A failed refresh keeps what is on screen; only a first load that fails is an error.
    if (mine === seq && c === client && state.status !== "ready") set({ status: "error" });
  }
}

const onUsed = () => {
  clearTimeout(settle);
  settle = setTimeout(() => void refreshAiUsage(true), SETTLE_MS);
};
const onVisible = () => {
  if (typeof document === "undefined" || !document.hidden) void refreshAiUsage();
};

function start() {
  window.addEventListener(AI_USED_EVENT, onUsed);
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  poll = setInterval(() => {
    if (!document.hidden) void refreshAiUsage();
  }, POLL_MS);
}
function stop() {
  window.removeEventListener(AI_USED_EVENT, onUsed);
  window.removeEventListener("focus", onVisible);
  document.removeEventListener("visibilitychange", onVisible);
  clearInterval(poll);
  clearTimeout(settle);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (++subscribers === 1) start();
  return () => {
    listeners.delete(listener);
    if (--subscribers === 0) stop();
  };
}

/** The live allowance for this account. Shows nothing wrong while loading or if it cannot load (callers render nothing then). */
export function useAiUsageState(supabase: SupabaseClient): UsageState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (client !== supabase) {
      // A different account (or a fresh app): forget the old numbers, then load.
      client = supabase;
      inflight = null;
      seq++;
      state = { status: "loading" };
      emit();
    }
    void refreshAiUsage();
  }, [supabase]);
  return snapshot;
}

/** Test helper: forget everything. */
export function resetAiUsageStore(): void {
  stop();
  subscribers = 0;
  listeners.clear();
  client = null;
  inflight = null;
  seq++;
  state = { status: "loading" };
}
