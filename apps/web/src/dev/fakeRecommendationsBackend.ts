import type { ExplainResponse, Recommendation, RecommendationsResponse } from "@copilot/shared";

/**
 * Fake in-memory recommendations for tests and the DEV-only /dev/recommendations preview. The recommendations are
 * fixtures (marked as such on the preview page) and are never produced for a real student; the explanation endpoint
 * behaves like the real one (one call, graceful "unavailable"). Never bundled into production: its only non-test importer
 * is the lazy, DEV-gated preview page.
 */

export interface RecoCall {
  method: string;
  url: string;
}

const base = (over: Partial<Recommendation> & Pick<Recommendation, "id" | "type" | "title" | "reason" | "actionText">): Recommendation => ({
  priority: "medium",
  subject: "Physics",
  topic: null,
  primary: "quiz",
  actions: [],
  facts: { accuracy: null, questions: 0, attempts: 0, repeatedMisses: 0, daysSincePracticed: null, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
  ...over,
});
const act = (kind: Recommendation["actions"][number]["kind"], label: string, over: Partial<Recommendation["actions"][number]> = {}) => ({ kind, label, subject: null, topic: null, count: null, draft: null, documentId: null, sessionId: null, ...over });

/** A student with a bit of everything. */
export function richRecommendations(): RecommendationsResponse {
  const sid = "00000000-0000-4000-8000-0000000000a1";
  return {
    today: "2026-10-15",
    summary: { topicsAnalyzed: 6, topicsWithEnoughData: 5, hasEnoughData: true },
    recommendations: [
      base({
        id: "URGENT_REVISION:photosynthesis",
        type: "URGENT_REVISION",
        priority: "high",
        subject: "Biology",
        topic: "Photosynthesis",
        title: "Revise Photosynthesis now",
        reason: "You scored 42% across 12 questions in 3 quiz attempts. You got the same 2 questions wrong in more than one attempt. You last practiced it 9 days ago.",
        actionText: "Practice 5 questions",
        primary: "quiz",
        actions: [act("quiz", "Start Practice", { subject: "Biology", topic: "Photosynthesis", count: 5 }), act("tutor", "Ask Tutor", { subject: "Biology", topic: "Photosynthesis", draft: "Explain the common mistakes I make in Photosynthesis" }), act("notes", "Review notes", { topic: "Photosynthesis", documentId: "00000000-0000-4000-8000-0000000000d1" }), act("viva", "Practice Viva", { subject: "Biology", topic: "Photosynthesis", count: 5 })],
        facts: { accuracy: 42, questions: 12, attempts: 3, repeatedMisses: 2, daysSincePracticed: 9, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
      }),
      base({
        id: "REPEATED_MISTAKE:integration-by-parts",
        type: "REPEATED_MISTAKE",
        priority: "medium",
        subject: "Mathematics",
        topic: "Integration by parts",
        title: "Fix repeated mistakes in Integration by parts",
        reason: "You scored 64% across 10 questions in 2 quiz attempts. You got the same question wrong in more than one attempt.",
        actionText: "Ask the AI Tutor to explain the common mistakes, then practice",
        primary: "tutor",
        actions: [act("tutor", "Ask Tutor", { subject: "Mathematics", topic: "Integration by parts", draft: "Explain the common mistakes I make in Integration by parts" }), act("quiz", "Start Practice", { subject: "Mathematics", topic: "Integration by parts", count: 5 })],
        facts: { accuracy: 64, questions: 10, attempts: 2, repeatedMisses: 1, daysSincePracticed: 2, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
      }),
      base({
        id: `UPCOMING_STUDY:${sid}`,
        type: "UPCOMING_STUDY",
        priority: "medium",
        subject: "Chemistry",
        topic: "Chemical bonding",
        title: "Continue: Chemical bonding",
        reason: "Planned for today: practice, 45 min.",
        actionText: "Continue your planned study session",
        primary: "plan",
        actions: [act("plan", "Open session", { subject: "Chemistry", topic: "Chemical bonding", sessionId: sid })],
        facts: { accuracy: null, questions: 0, attempts: 0, repeatedMisses: 0, daysSincePracticed: null, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: "2026-10-15" },
      }),
      base({
        id: "PRACTICE_MORE:thermodynamics",
        type: "PRACTICE_MORE",
        priority: "low",
        subject: "Physics",
        topic: "Thermodynamics",
        title: "Practice Thermodynamics",
        reason: "You scored 60% across 5 questions. You last practiced it 12 days ago.",
        actionText: "Practice 5 questions",
        actions: [act("quiz", "Start Practice", { subject: "Physics", topic: "Thermodynamics", count: 5 }), act("tutor", "Ask Tutor", { subject: "Physics", topic: "Thermodynamics", draft: "Explain Thermodynamics step by step, then test my understanding" })],
        facts: { accuracy: 60, questions: 5, attempts: 1, repeatedMisses: 0, daysSincePracticed: 12, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
      }),
      base({
        id: "IMPROVING:integration",
        type: "IMPROVING",
        priority: "low",
        subject: "Mathematics",
        topic: "Integration",
        title: "You're improving at Integration",
        reason: "Your recent performance improved from 54% to 78%. Keep practicing to maintain progress.",
        actionText: "Practice 5 more questions to lock it in",
        actions: [act("quiz", "Practice", { subject: "Mathematics", topic: "Integration", count: 5 })],
        facts: { accuracy: 66, questions: 14, attempts: 3, repeatedMisses: 0, daysSincePracticed: 1, vivaAverage: null, vivaSessions: 0, trend: { previous: 54, recent: 78 }, scheduledOn: null },
      }),
      base({
        id: "MAINTAIN_STRENGTH:waves",
        type: "MAINTAIN_STRENGTH",
        priority: "low",
        subject: "Physics",
        topic: "Waves",
        title: "Keep Waves fresh",
        reason: "You scored 92% across 12 questions. You last practiced it 16 days ago. A short refresher keeps it fresh.",
        actionText: "A 5-question mini quiz keeps it fresh",
        actions: [act("quiz", "Take a mini quiz", { subject: "Physics", topic: "Waves", count: 5 })],
        facts: { accuracy: 92, questions: 12, attempts: 2, repeatedMisses: 0, daysSincePracticed: 16, vivaAverage: null, vivaSessions: 0, trend: null, scheduledOn: null },
      }),
    ],
  };
}

/** A student with only a plan session: recommendations exist but there is not enough learning data. */
export const planOnly = (): RecommendationsResponse => ({ ...richRecommendations(), summary: { topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false }, recommendations: richRecommendations().recommendations.filter((r) => r.type === "UPCOMING_STUDY") });

export const emptyRecommendations = (): RecommendationsResponse => ({ today: "2026-10-15", summary: { topicsAnalyzed: 0, topicsWithEnoughData: 0, hasEnoughData: false }, recommendations: [] });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function makeRecommendationsBackend(initial: RecommendationsResponse = richRecommendations()) {
  const calls: RecoCall[] = [];
  const knobs = {
    data: initial,
    failNext: false,
    delayMs: 0,
    /** What the explanation endpoint returns. */
    explain: null as ExplainResponse | null,
  };
  async function fetchMock(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    // The app asks who the account is (role / paused) once on load; that is not one of this feature's requests.
    if (url === "/api/me") return json(200, { user: { id: "11111111-1111-4111-8111-111111111111", email: "sample@example.com" }, profile: { id: "11111111-1111-4111-8111-111111111111", displayName: "Sample", timezone: "UTC", role: "student" } });
    // Likewise the top-bar pill's free read of today's AI allowance.
    if (url === "/api/me/ai-usage") return json(200, { unlimited: false, limit: 100, used: 10, remaining: 90, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() });
    calls.push({ method, url });
    if (knobs.delayMs) await new Promise((r) => setTimeout(r, knobs.delayMs));
    if (knobs.failNext) {
      knobs.failNext = false;
      return json(500, { error: "internal_error", message: "Something went wrong." });
    }
    const m = /^\/api\/recommendations(?:\?limit=(\d+))?$/.exec(url);
    if (m && method === "GET") return json(200, { ...knobs.data, recommendations: knobs.data.recommendations.slice(0, m[1] ? Number(m[1]) : 10) });
    if (url === "/api/recommendations/explain" && method === "POST") {
      const ids = knobs.data.recommendations.slice(0, 5).map((r) => r.id);
      return json(
        200,
        knobs.explain ?? {
          available: true,
          message: null,
          overview: "Start with your weakest topic, then keep the others warm.",
          items: ids.map((id) => ({ id, text: "This matters now, so start here." })),
          isMock: false,
          model: "llama3.2:3b",
        },
      );
    }
    return json(404, { error: "not_found", message: "Not found." });
  }
  return { fetchMock, calls, knobs };
}
