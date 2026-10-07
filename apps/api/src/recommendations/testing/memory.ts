import type { Extras, ExtrasRepository } from "../repository.js";
import type { RepeatedFact, SourceFact, TutorFact } from "../engine.js";

/** In-memory ExtrasRepository for tests: everything is scoped by user id. */
export function createInMemoryExtrasRepository() {
  const data = new Map<string, Extras>();
  const of = (userId: string): Extras => data.get(userId) ?? { repeated: [], sources: [], tutor: [], plan: null };
  const calls = { load: 0 };
  const repo: ExtrasRepository = {
    async load(userId) {
      calls.load++;
      const e = of(userId);
      return { repeated: [...e.repeated], sources: [...e.sources], tutor: [...e.tutor], plan: e.plan };
    },
  };
  const set = (userId: string, patch: Partial<Extras>) => data.set(userId, { ...of(userId), ...patch });
  return {
    repo,
    calls,
    addRepeated: (userId: string, f: RepeatedFact) => set(userId, { repeated: [...of(userId).repeated, f] }),
    addSource: (userId: string, f: SourceFact) => set(userId, { sources: [...of(userId).sources, f] }),
    addTutor: (userId: string, f: TutorFact) => set(userId, { tutor: [...of(userId).tutor, f] }),
    setPlan: (userId: string, plan: Extras["plan"]) => set(userId, { plan }),
  };
}
