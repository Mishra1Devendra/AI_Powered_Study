import { useId, type ReactNode } from "react";
import { Card } from "./Card";

interface SectionProps {
  title: string;
  /** Optional right-aligned element, e.g. a "View all" link. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Titled dashboard block with a proper landmark label. */
export function Section({ title, action, className = "", children }: SectionProps) {
  const id = useId();
  return (
    <Card className={className}>
      <section aria-labelledby={id}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={id} className="text-base font-semibold tracking-tight text-slate-900">
            {title}
          </h2>
          {action}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** Compact empty state used inside sections (smaller than the full-page EmptyState). */
export function SectionEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-5 py-8 text-center">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-slate-600">{children}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
