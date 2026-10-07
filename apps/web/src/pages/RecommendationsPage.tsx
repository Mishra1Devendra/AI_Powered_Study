import { useMemo, useState } from "react";
import { RECOMMENDATION_SECTIONS, SECTION_LABEL, SECTION_OF_TYPE, type ExplainResponse, type Recommendation, type RecommendationSection } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { LinkButton } from "../components/ui/LinkButton";
import { ExplainPanel } from "../features/recommendations/ExplainPanel";
import { RecommendationCard } from "../features/recommendations/RecommendationCard";
import { useRecommendations } from "../features/recommendations/useRecommendations";

/** How many of the most important recommendations are pulled into "Recommended now". */
const NOW_COUNT = 3;

function Skeleton() {
  return (
    <div role="status" aria-label="Loading your recommendations" className="space-y-4">
      <span className="sr-only">Loading your recommendations…</span>
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <div className="flex gap-3.5">
            <div className="h-11 w-11 animate-pulse rounded-2xl bg-slate-200/80" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-slate-200/80" />
              <div className="h-5 w-2/3 animate-pulse rounded bg-slate-200/80" />
            </div>
          </div>
          <div className="mt-4 h-4 w-full animate-pulse rounded bg-slate-200/80" />
          <div className="mt-2 h-4 w-4/5 animate-pulse rounded bg-slate-200/80" />
        </Card>
      ))}
    </div>
  );
}

function NotEnoughData() {
  return (
    <Card className="mx-auto max-w-2xl text-center">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">Keep learning to unlock personalized recommendations.</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">Not enough learning data yet. Complete a few quizzes or study sessions to unlock personalized recommendations.</p>
      <ul className="mx-auto mt-4 max-w-md space-y-1.5 text-left text-sm text-slate-700">
        <li>• Answer at least 5 quiz questions on a topic, so the app can tell how you are doing on it.</li>
        <li>• Retake a quiz, so it can spot mistakes you repeat and see whether you are improving.</li>
        <li>• Complete study sessions and try a viva, so it knows what you have practiced recently.</li>
      </ul>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <LinkButton to="/quiz">Take a quiz</LinkButton>
        <LinkButton to="/study-plan" variant="secondary">
          Open study plan
        </LinkButton>
      </div>
    </Card>
  );
}

/** `/recommendations`: what to study next, why, and the best way to revise it - from the student's own learning data. */
export default function RecommendationsPage() {
  const { client } = useAuth();
  const { state, reload } = useRecommendations(client);
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const aiText = useMemo(() => new Map((explain?.items ?? []).map((i) => [i.id, i.text])), [explain]);

  const data = state.status === "ready" ? state.data : null;
  const { now, sections } = useMemo(() => {
    const recs = data?.recommendations ?? [];
    const urgent = recs.filter((r) => SECTION_OF_TYPE[r.type] !== "strong" && SECTION_OF_TYPE[r.type] !== "improving").slice(0, NOW_COUNT);
    const shown = new Set(urgent.map((r) => r.id));
    const by = new Map<RecommendationSection, Recommendation[]>();
    for (const r of recs) if (!shown.has(r.id)) by.set(SECTION_OF_TYPE[r.type], [...(by.get(SECTION_OF_TYPE[r.type]) ?? []), r]);
    return { now: urgent, sections: by };
  }, [data]);

  return (
    <div className="animate-fade-up mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your Smart Study Recommendations</h1>
        <p className="mt-1 max-w-xl text-sm leading-relaxed text-slate-600">Personalized recommendations based on your learning activity, practice and performance.</p>
      </header>

      {state.status === "loading" && <Skeleton />}
      {state.status === "error" && (
        <div className="mx-auto max-w-md space-y-3 py-6 text-center">
          <Alert tone="error">We couldn&apos;t load your recommendations.</Alert>
          <p className="text-sm text-slate-600">{state.message}</p>
          <Button variant="secondary" onClick={() => void reload()}>
            Try Again
          </Button>
        </div>
      )}

      {data && (
        <>
          {!data.summary.hasEnoughData && data.recommendations.length === 0 && <NotEnoughData />}
          {!data.summary.hasEnoughData && data.recommendations.length > 0 && (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Keep learning to unlock personalized recommendations. These come from your study plan only; answer at least 5 quiz questions on a topic and complete a few sessions to get advice based on how you are doing.
            </p>
          )}

          {data.recommendations.length > 0 && (
            <>
              <p className="text-sm text-slate-600">
                Calculated from your own quizzes, vivas, study sessions and tutor chats ({data.summary.topicsAnalyzed} {data.summary.topicsAnalyzed === 1 ? "topic" : "topics"}). It works without AI; the explanation below is optional.
              </p>
              <ExplainPanel onResult={setExplain} />
            </>
          )}

          {now.length > 0 && (
            <section aria-labelledby="now-h" className="space-y-4">
              <h2 id="now-h" className="text-lg font-semibold tracking-tight text-slate-900">
                Recommended Now
              </h2>
              {now.map((r) => (
                <RecommendationCard key={r.id} rec={r} aiText={aiText.get(r.id)} />
              ))}
            </section>
          )}

          {RECOMMENDATION_SECTIONS.map((section) => {
            const list = sections.get(section);
            if (!list || list.length === 0) return null;
            return (
              <section key={section} aria-labelledby={`h-${section}`} className="space-y-4">
                <h2 id={`h-${section}`} className="text-lg font-semibold tracking-tight text-slate-900">
                  {SECTION_LABEL[section]}
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {list.map((r) => (
                    <RecommendationCard key={r.id} rec={r} aiText={aiText.get(r.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
