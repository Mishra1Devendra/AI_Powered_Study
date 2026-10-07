import { Link } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { ArrowRightIcon } from "../../components/ui/Icons";
import { useStoredResume } from "./resumeStore";

/**
 * The reusable "Continue learning" shortcut for module screens and the sidebar. It shows what the dashboard already worked out
 * (an unfinished session, quiz or viva, or recent activity) and renders NOTHING when there is none - never a placeholder.
 * `hideFor` hides it on the screen it would point to.
 */
export function ContinueBar({ variant = "bar", hideFor, role }: { variant?: "bar" | "sidebar"; hideFor?: string; role?: "menuitem" }) {
  const { user } = useAuth();
  const resume = useStoredResume(user?.id);
  if (!resume || (hideFor && resume.href.startsWith(hideFor))) return null;
  if (variant === "sidebar") {
    return (
      <Link to={resume.href} {...(role ? { role } : {})} className="mb-3 block rounded-xl bg-brand-50 px-3 py-2.5 text-left ring-1 ring-brand-100 transition hover:bg-brand-100/60">
        <span className="block text-xs font-semibold uppercase tracking-wide text-brand-700">Continue learning</span>
        <span className="mt-0.5 block truncate text-sm font-medium text-slate-900">{resume.title}</span>
      </Link>
    );
  }
  return (
    <Link
      to={resume.href}
      {...(role ? { role } : {})}
      aria-label={`Continue learning: ${resume.title}`}
      className="flex items-center gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm ring-1 ring-brand-100 transition hover:bg-brand-100/60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wide text-brand-700">{resume.eyebrow}</span>
        <span className="block truncate font-medium text-slate-900">{resume.title}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-700">
        {resume.cta}
        <ArrowRightIcon className="h-4 w-4" />
      </span>
    </Link>
  );
}
