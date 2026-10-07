function Bone({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200/70 ${className}`} />;
}

/** Mirrors the real layout so the page does not jump when data arrives. */
export function DashboardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your dashboard" className="space-y-6">
      <div className="space-y-2">
        <Bone className="h-4 w-40" />
        <Bone className="h-9 w-72 max-w-full" />
        <Bone className="h-5 w-64 max-w-full" />
      </div>
      <Bone className="h-52 w-full !rounded-(--radius-card)" />
      <Bone className="h-44 w-full !rounded-(--radius-card)" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Bone key={i} className="h-28 !rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Bone className="h-40 !rounded-(--radius-card)" />
          <Bone className="h-64 !rounded-(--radius-card)" />
        </div>
        <div className="space-y-6 xl:col-span-2">
          <Bone className="h-52 !rounded-(--radius-card)" />
          <Bone className="h-52 !rounded-(--radius-card)" />
        </div>
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
