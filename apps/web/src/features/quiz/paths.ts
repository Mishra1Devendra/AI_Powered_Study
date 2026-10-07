import { createContext, useContext, useMemo } from "react";

interface Bases {
  /** Where the quiz screens live (the dev preview mounts them elsewhere). */
  quiz: string;
  /** Where "Ask AI to explain" sends the student. */
  tutor: string;
}

export const QuizBaseContext = createContext<Bases>({ quiz: "/quiz", tutor: "/tutor" });

/** Every in-app link of the quiz screens, built from one base so the screens can be mounted anywhere. */
export function useQuizPaths() {
  const base = useContext(QuizBaseContext);
  return useMemo(
    () => ({
      home: base.quiz,
      create: `${base.quiz}/new`,
      quiz: (id: string) => `${base.quiz}/${id}`,
      attempt: (id: string) => `${base.quiz}/attempt/${id}`,
      result: (id: string) => `${base.quiz}/attempt/${id}/result`,
      tutor: base.tutor,
    }),
    [base],
  );
}
