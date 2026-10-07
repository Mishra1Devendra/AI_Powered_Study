import { createContext, useContext, useMemo } from "react";

interface Bases {
  /** Where the viva screens live (the dev preview mounts them elsewhere). */
  viva: string;
  /** Where "Ask AI Tutor" sends the student. */
  tutor: string;
}

export const VivaBaseContext = createContext<Bases>({ viva: "/viva", tutor: "/tutor" });

export function useVivaPaths() {
  const base = useContext(VivaBaseContext);
  return useMemo(() => ({ home: base.viva, session: (id: string) => `${base.viva}/${id}`, tutor: base.tutor }), [base]);
}
