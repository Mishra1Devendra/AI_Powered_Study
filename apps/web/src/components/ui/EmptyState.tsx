import type { ReactNode } from "react";
import { EmblemBadge } from "./EmblemBadge";

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center">
      {icon && <EmblemBadge className="mb-4 h-14 w-14">{icon}</EmblemBadge>}
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {children && <p className="mt-1.5 max-w-sm text-sm text-slate-600">{children}</p>}
    </div>
  );
}
