import type { ReactNode } from "react";

/**
 * A round badge for first-run ("nothing here yet") screens: lapis disc, gold ring and two gold specks, echoing the app's emblem.
 * Purely decorative (hidden from assistive technology); the words next to it carry the meaning.
 */
export function EmblemBadge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full brand-chip shadow-md ring-4 ring-accent-100 ${className}`}>
      {children}
      <span className="absolute -right-1 -top-0.5 h-3 w-3 rounded-full bg-[#e8c25c]" />
      <span className="absolute -bottom-0.5 -left-1.5 h-2 w-2 rounded-full bg-[#e8c25c]/70" />
    </span>
  );
}
