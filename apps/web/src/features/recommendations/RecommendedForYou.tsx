import { Link } from "react-router";
import { TYPE_LABEL, type Recommendation, type RecommendationsResponse } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorState } from "../../components/ui/ErrorState";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { SkeletonRegion, Skeleton } from "../../components/ui/Skeleton";
import { friendlyMessage } from "../../lib/errors";
import { ActionButton } from "./RecommendationCard";
import { useRecoPaths } from "./paths";
import { useRecommendations } from "./useRecommendations";

export type RecoLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: RecommendationsResponse };

/** One compact recommendation: WHAT to do, WHY (from the student's own facts), and the ACTION button. */
function Item({ rec }: { rec: Recommendation }) {
  const action = rec.actions.find((a) => a.kind === rec.primary) ?? rec.actions[0]!;
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{TYPE_LABEL[rec.type]}</p>
      <h3 className="mt-0.5 break-words text-sm font-semibold text-slate-900">{rec.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-slate-700">
        <span className="font-medium text-slate-900">Why: </span>
        {rec.reason}
      </p>
      <div className="mt-2.5">
        <ActionButton action={action} primary={false} topicLabel={rec.topic ?? ""} />
      </div>
    </li>
  );
}

/**
 * The compact dashboard card: the top three recommendations (deterministic, from the student's own data - no AI), each with what,
 * why and a button that opens the right screen ready to go. It only DISPLAYS a load state, so the dashboard can share one request
 * between this card and its "continue learning" hero.
 */
export function RecommendedForYouView({ state, onRetry }: { state: RecoLoad; onRetry: () => void }) {
  const p = useRecoPaths();
  const current = state;
  const retry = onRetry;
  const list = current.status === "ready" ? current.data.recommendations.slice(0, 3) : [];
  return (
    <Section
      title="Recommended for You"
      action={
        <Link to={p.home} className="text-sm font-medium text-brand-700 hover:underline">
          View All →
        </Link>
      }
    >
      {current.status === "loading" && (
        <SkeletonRegion label="Loading your recommendations" className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3.5 w-full" />
            </div>
          ))}
        </SkeletonRegion>
      )}
      {current.status === "error" && <ErrorState compact message="We couldn't load your recommendations." onRetry={retry} retryLabel="Try Again" />}
      {list.length > 0 && (
        <ol className="divide-y divide-slate-100">
          {list.map((r) => (
            <Item key={r.id} rec={r} />
          ))}
        </ol>
      )}
      {current.status === "ready" && list.length === 0 && (
        <SectionEmpty title="Keep learning to unlock personalized recommendations.">Complete a few quizzes or study sessions and your next steps will appear here.</SectionEmpty>
      )}
    </Section>
  );
}

/** The same card, loading its own data (for screens that do not already have it). */
export function RecommendedForYou() {
  const { client } = useAuth();
  const { state, reload } = useRecommendations(client, 3);
  const view: RecoLoad = state.status === "error" ? { status: "error", message: friendlyMessage(null) } : (state as RecoLoad);
  return <RecommendedForYouView state={view} onRetry={() => void reload()} />;
}
