import type { HTMLAttributes } from "react";

export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={`rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6 ${className}`} />;
}
