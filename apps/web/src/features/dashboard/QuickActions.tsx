import { Link } from "react-router";
import { isBuilt } from "../../components/layout/nav";
import { PlanIcon, QuizIcon, TutorIcon, UploadIcon, VivaIcon } from "../../components/ui/Icons";

const ACTIONS = [
  { to: "/tutor", title: "Ask AI Tutor", desc: "Get a concept explained", icon: TutorIcon },
  { to: "/notes", title: "Upload Notes", desc: "Turn material into notes", icon: UploadIcon },
  { to: "/quiz", title: "Start Quiz", desc: "Test what you know", icon: QuizIcon },
  { to: "/study-plan", title: "Study Plan", desc: "Plan your week", icon: PlanIcon },
  { to: "/viva", title: "Start Viva", desc: "Practice speaking answers", icon: VivaIcon },
] as const;

export function QuickActions() {
  return (
    <section aria-labelledby="quick-actions">
      <h2 id="quick-actions" className="mb-3 text-base font-semibold tracking-tight text-slate-900">
        Quick actions
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ACTIONS.map(({ to, title, desc, icon: Icon }, i) => (
          <li key={to} className={i === ACTIONS.length - 1 ? "col-span-2 sm:col-span-1" : undefined}>
            <Link
              to={to}
              className="group relative flex h-full flex-col gap-3 rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:ring-brand-500/40"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition group-hover:bg-brand-600 group-hover:text-white">
                <Icon />
              </span>
              {!isBuilt(to) && (
                <span className="absolute right-3 top-3 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-600">
                  Soon
                </span>
              )}
              <span>
                <span className="block text-sm font-semibold text-slate-900">{title}</span>
                <span className="mt-0.5 block text-sm text-slate-600">{desc}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
