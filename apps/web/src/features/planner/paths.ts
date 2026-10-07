import { createContext, useContext, useMemo } from "react";

interface Bases {
  /** Where the study plan screens live (the dev preview mounts them elsewhere). */
  planner: string;
  /** Where "Open AI Tutor" sends the student. */
  tutor: string;
  /** Where quiz sessions send the student. */
  quiz: string;
}

export const PlannerBaseContext = createContext<Bases>({ planner: "/study-plan", tutor: "/tutor", quiz: "/quiz" });

/** Every in-app link of the planner screens, built from one base so the screens can be mounted anywhere. */
export function usePlannerPaths() {
  const base = useContext(PlannerBaseContext);
  return useMemo(
    () => ({
      home: base.planner,
      create: `${base.planner}/new`,
      plan: (id: string) => `${base.planner}/${id}`,
      tutor: base.tutor,
      quizCreate: `${base.quiz}/new`,
    }),
    [base],
  );
}
