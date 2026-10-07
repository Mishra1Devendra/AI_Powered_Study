import { createContext, useContext, useMemo } from "react";
import type { RecommendationAction } from "@copilot/shared";

interface Bases {
  /** Where the existing screens live (the dev preview mounts them elsewhere). */
  quiz: string;
  viva: string;
  tutor: string;
  notes: string;
  studyPlan: string;
  recommendations: string;
}

export const DEFAULT_RECO_BASES: Bases = { quiz: "/quiz", viva: "/viva", tutor: "/tutor", notes: "/notes", studyPlan: "/study-plan", recommendations: "/recommendations" };
export const RecoBaseContext = createContext<Bases>(DEFAULT_RECO_BASES);
export type RecoBases = Bases;

const qs = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Where a recommendation's button goes. Every destination is an EXISTING screen opened with the details filled in;
 * nothing is created or sent by following one (a quiz, viva or tutor message only starts when the student presses the
 * button there). The Tutor is the one exception to "a link": its suggested question travels as navigation state.
 */
export function useRecoPaths() {
  const base = useContext(RecoBaseContext);
  return useMemo(
    () => ({
      home: base.recommendations,
      /** A link for an action, or null when the action is opened by navigation state (tutor). */
      href(a: RecommendationAction): string | null {
        switch (a.kind) {
          case "quiz":
            return `${base.quiz}/new${qs({ subject: a.subject, topic: a.topic, count: a.count })}`;
          case "viva":
            return `${base.viva}${qs({ subject: a.subject, topic: a.topic })}`;
          case "notes":
            return a.documentId ? `${base.notes}/${a.documentId}` : null;
          case "plan":
            return a.sessionId ? `${base.studyPlan}${qs({ session: a.sessionId })}` : base.studyPlan;
          case "tutor":
            return null;
        }
      },
      tutor: base.tutor,
    }),
    [base],
  );
}

/**
 * The destination of a recommendation action as plain data (a path, plus navigation state for the Tutor). Following it only
 * OPENS an existing screen with details filled in; nothing is created or sent.
 */
export function actionTarget(base: RecoBases, a: RecommendationAction): { to: string; state?: unknown } {
  switch (a.kind) {
    case "quiz":
      return { to: `${base.quiz}/new${qs({ subject: a.subject, topic: a.topic, count: a.count })}` };
    case "viva":
      return { to: `${base.viva}${qs({ subject: a.subject, topic: a.topic })}` };
    case "notes":
      return { to: a.documentId ? `${base.notes}/${a.documentId}` : base.notes };
    case "plan":
      return { to: a.sessionId ? `${base.studyPlan}${qs({ session: a.sessionId })}` : base.studyPlan };
    case "tutor":
      return { to: base.tutor, state: { draft: a.draft ?? "", ...(a.subject ? { subject: a.subject } : {}), ...(a.topic ? { topic: a.topic } : {}) } };
  }
}
