import { Skeleton, SkeletonRegion, SkeletonCard, SkeletonList } from "./Skeleton";

/**
 * The standard "this screen is loading" placeholder: skeleton shapes (not a bare spinner) under ONE announcement for
 * assistive technology. `shape` picks the closest layout so the page does not jump when the data arrives.
 */
export function LoadingState({ label, shape = "cards" }: { label: string; shape?: "cards" | "list" | "form" }) {
  return (
    <SkeletonRegion label={label} className="space-y-4 py-4">
      {shape === "list" && (
        <div className="rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70">
          <SkeletonList rows={4} />
        </div>
      )}
      {shape === "cards" && (
        <>
          <SkeletonCard lines={2} action />
          <SkeletonCard lines={3} />
        </>
      )}
      {shape === "form" && (
        <div className="space-y-5">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-2/3 rounded-xl" />
        </div>
      )}
    </SkeletonRegion>
  );
}
