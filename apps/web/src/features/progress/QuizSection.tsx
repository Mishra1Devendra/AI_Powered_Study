import type { ProgressResponse } from "@copilot/shared";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section, SectionEmpty } from "../../components/ui/Section";
import { ScoreTrendChart } from "./charts";
import { pctText } from "./format";
import { useProgressPaths } from "./paths";

export function QuizSection({ data }: { data: ProgressResponse }) {
  const p = useProgressPaths();
  const q = data.quiz;
  return (
    <Section title="Quiz scores" className="h-full">
      {q.attemptsCompleted > 0 ? (
        <>
          <ScoreTrendChart quiz={q} />
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Answered correctly", `${q.correct} of ${q.questions}`],
              ["Answered wrongly", String(q.incorrect)],
              ["Left unanswered", String(q.unanswered)],
              ["Accuracy", pctText(q.accuracy)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-xs text-slate-600">{label}</dt>
                <dd className="text-lg font-semibold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
          {q.byDifficulty.some((d) => d.accuracy !== null) && (
            <p className="mt-3 text-sm text-slate-700">
              By difficulty:{" "}
              {q.byDifficulty
                .filter((d) => d.accuracy !== null)
                .map((d) => `${d.difficulty} ${pctText(d.accuracy)}`)
                .join(" · ")}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-600">Unanswered questions count as not correct, the same as in your quiz score.</p>
        </>
      ) : (
        <SectionEmpty
          title="No finished quizzes yet"
          action={
            <LinkButton to={p.quizHome} variant="secondary" size="sm">
              Take a quiz
            </LinkButton>
          }
        >
          Your score trend appears once you have finished a quiz{data.range === "all" ? "" : " in this period"}.
        </SectionEmpty>
      )}
    </Section>
  );
}
