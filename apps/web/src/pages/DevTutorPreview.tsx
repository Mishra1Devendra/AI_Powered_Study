import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useMemo } from "react";
import { AuthProvider } from "../auth/AuthProvider";
import { makeBackend, uid } from "../dev/fakeTutorBackend";
import TutorPage from "./TutorPage";

const USER = "00000000-0000-4000-8000-0000000000aa";

/**
 * DEV-ONLY visual preview of the AI Tutor at /dev/tutor. It swaps `fetch` for an in-memory fake
 * backend and uses a fake auth client while mounted, so nothing touches the real API or database.
 * Excluded from production builds (lazy, DEV-gated import in App.tsx).
 */
export default function DevTutorPreview() {
  const backend = useMemo(() => {
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const c1 = { id: uid(1), title: "Entropy basics", subject: "Physics", topic: "Thermodynamics", level: "intermediate" as const, createdAt: ago(300), updatedAt: ago(30) };
    const c2 = { id: uid(2), title: "Integration by substitution", subject: "Mathematics", topic: null, level: null, createdAt: ago(2000), updatedAt: ago(1500) };
    const c3 = { id: uid(3), title: "Entropy, from my notes", subject: null, topic: null, level: null, createdAt: ago(60), updatedAt: ago(5) };
    const b = makeBackend({ conversations: [c3, c1, c2], richReplies: true, chunkDelayMs: 40, mock: true });
    const doc = uid(9);
    b.messages[c3.id] = [
      b.mk(c3.id, "user", "What does my Thermodynamics document say about entropy?"),
      b.mk(c3.id, "assistant", "From your notes: entropy is a measure of the disorder of a system, and the second law says the entropy of an isolated system never decreases [S1]. Heat flows from hot to cold bodies, which increases entropy [S2].", {
        isMock: false,
        model: "llama3.2:3b",
        grounding: "grounded",
        sources: [
          { key: "S1", chunkIndex: 3, page: 14, heading: "Entropy", documentId: doc, documentTitle: "Thermodynamics.pdf" },
          { key: "S2", chunkIndex: 4, page: null, heading: "Heat flow", documentId: doc, documentTitle: "Thermodynamics.pdf" },
        ],
      }),
      b.mk(c3.id, "user", "What is the Carnot efficiency formula?"),
      b.mk(c3.id, "assistant", "I couldn't find this topic in your uploaded material. I can still explain it using general knowledge.", { isMock: false, model: "knowledge-index", grounding: "not_found" }),
    ];
    b.messages[c1.id] = [
      b.mk(c1.id, "user", "What is entropy?"),
      b.mk(c1.id, "assistant", "Entropy measures how many ways energy can be arranged. **Higher entropy** means more possible arrangements.\n\n- It rises in isolated systems\n- $\\Delta S \\ge 0$ for the whole universe", { isMock: true }),
    ];
    b.messages[c2.id] = [b.mk(c2.id, "user", "How do I pick u?"), b.mk(c2.id, "assistant", "Pick $u$ so that $du$ appears elsewhere in the integrand.", { isMock: true })];
    return b;
  }, []);

  const client = useMemo(() => {
    const session = { access_token: "dev-preview", user: { id: USER, email: "preview@example.com" } } as unknown as Session;
    return {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
        signOut: async () => ({ error: null }),
      },
    } as unknown as SupabaseClient;
  }, []);

  // Layout effects run before any child effect, so the fake is in place before the first request.
  useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = backend.fetchMock as typeof window.fetch;
    return () => {
      window.fetch = original;
    };
  }, [backend]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
        <strong>SAMPLE DATA - design preview only.</strong> Fake in-memory tutor, no real AI or database. Replies stream slowly on purpose.
      </div>
      <div className="min-h-0 flex-1">
        <AuthProvider client={client}>
          <TutorPage basePath="/dev/tutor" />
        </AuthProvider>
      </div>
    </div>
  );
}
