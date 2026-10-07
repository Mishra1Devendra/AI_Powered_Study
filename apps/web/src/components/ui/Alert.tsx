import type { ReactNode } from "react";

const tones = {
  error: "bg-red-50 text-red-800 ring-red-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  info: "bg-brand-50 text-brand-700 ring-brand-100",
} as const;

export function Alert({ tone = "info", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl px-4 py-3 text-sm ring-1 ${tones[tone]}`}>
      {children}
    </div>
  );
}
