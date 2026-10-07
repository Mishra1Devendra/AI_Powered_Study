export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function FullPageSpinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-screen items-center justify-center gap-3 text-slate-500">
      <Spinner />
      <span className="text-sm">{label}…</span>
    </div>
  );
}
