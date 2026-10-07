import { Link } from "react-router";
import type { ActivityItem } from "@copilot/shared";
import { ClockIcon, NotesIcon, QuizIcon, TutorIcon } from "../../components/ui/Icons";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { relativeTime } from "./format";

const TYPES = {
  quiz: { label: "Quiz", Icon: QuizIcon },
  note: { label: "Notes", Icon: NotesIcon },
  session: { label: "Study session", Icon: ClockIcon },
  tutor: { label: "AI Tutor", Icon: TutorIcon },
} as const;


function Row({ item, now }: { item: ActivityItem; now: Date }) {
  const { label, Icon } = TYPES[item.type];
  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-900">{item.title}</span>
        <span className="block truncate text-sm text-slate-600">
          {label}
          {item.detail ? ` · ${item.detail}` : ""}
        </span>
      </span>
      <time dateTime={item.occurredAt} className="shrink-0 text-xs text-slate-500">
        {relativeTime(item.occurredAt, now)}
      </time>
    </>
  );
  return (
    <li>
      {item.href ? (
        <Link to={item.href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-slate-50">
          {body}
        </Link>
      ) : (
        <div className="flex items-center gap-3 py-3">{body}</div>
      )}
    </li>
  );
}

export function RecentActivity({ items, now }: { items: ActivityItem[]; now: Date }) {
  return (
    <Section title="Recent activity">
      {items.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <Row key={item.id} item={item} now={now} />
          ))}
        </ul>
      ) : (
        <SectionEmpty title="No activity yet">
          Your quizzes, notes, study sessions and tutor conversations will be listed here.
        </SectionEmpty>
      )}
    </Section>
  );
}
