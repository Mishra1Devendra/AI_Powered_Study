import { Link } from "react-router";
import type { WeakTopic } from "@copilot/shared";
import { CheckIcon, TargetIcon } from "../../components/ui/Icons";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section, SectionEmpty } from "../../components/ui/Section";

const STATUS = {
  needs_attention: { label: "Needs attention", classes: "bg-amber-50 text-amber-800", Icon: TargetIcon },
  improving: { label: "Improving", classes: "bg-emerald-50 text-emerald-700", Icon: CheckIcon },
} as const;

export function WeakTopics({ topics }: { topics: WeakTopic[] }) {
  return (
    <Section title="Weak topics">
      {topics.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {topics.map((t) => {
            const s = STATUS[t.status];
            return (
              <li key={t.id}>
                <Link to={t.href} className="-mx-2 block rounded-xl px-2 py-3 transition hover:bg-slate-50">
                  <span className="block text-xs font-medium text-slate-500">{t.subject}</span>
                  <span className="mt-0.5 block text-sm font-semibold text-slate-900">{t.topic}</span>
                  <span className="mt-2 flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${s.classes}`}>
                      <s.Icon className="h-3.5 w-3.5" />
                      {s.label}
                    </span>
                    {t.accuracyPercent !== null && (
                      <span className="text-sm tabular-nums text-slate-600">{Math.round(t.accuracyPercent)}% accuracy</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <SectionEmpty
          title="No weak topics identified yet"
          action={
            <LinkButton to="/quiz" variant="secondary" size="sm">
              Start a quiz
            </LinkButton>
          }
        >
          We only flag a topic after you have answered enough questions on it, so this reflects your real results.
        </SectionEmpty>
      )}
    </Section>
  );
}
