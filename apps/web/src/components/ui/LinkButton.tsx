import type { ReactNode } from "react";
import { Link } from "react-router";

const styles = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700",
  secondary: "bg-white text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50",
  ghost: "text-brand-700 hover:bg-brand-50",
} as const;

interface LinkButtonProps {
  to: string;
  variant?: keyof typeof styles;
  size?: "md" | "sm";
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  /** Navigation state handed to the next screen (e.g. a suggested tutor question). Nothing is sent by following the link. */
  state?: unknown;
}

/** A router <Link> that looks like a Button (navigation, so it must be a real link). */
export function LinkButton({ to, variant = "primary", size = "md", children, className = "", state, ...rest }: LinkButtonProps) {
  const sizing = size === "md" ? "h-11 px-5" : "h-9 px-3.5";
  return (
    <Link
      to={to}
      {...(state !== undefined ? { state } : {})}
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors ${sizing} ${styles[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
