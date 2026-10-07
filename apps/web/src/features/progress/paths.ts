import { createContext, useContext, useMemo } from "react";

interface Bases {
  quiz: string;
  tutor: string;
  studyPlan: string;
}

/** Where Progress links to (the dev preview mounts the other screens elsewhere). */
export const ProgressBaseContext = createContext<Bases>({ quiz: "/quiz", tutor: "/tutor", studyPlan: "/study-plan" });

export function useProgressPaths() {
  const base = useContext(ProgressBaseContext);
  return useMemo(
    () => ({
      tutor: base.tutor,
      studyPlan: base.studyPlan,
      quizHome: base.quiz,
      /** The quiz form opens with the topic filled in; nothing is generated until the student presses Create. */
      practice: (subject: string | null, topic: string) => `${base.quiz}/new?${new URLSearchParams({ ...(subject ? { subject } : {}), topic }).toString()}`,
    }),
    [base],
  );
}
