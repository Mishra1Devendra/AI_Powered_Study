import type { ProgressSnapshot } from "@copilot/shared";
import { LinkButton } from "../../components/ui/LinkButton";
import { Section } from "../../components/ui/Section";

/** The AI Viva entry point. The score is the student's real latest completed viva; with none, no score is shown. */
export function VivaCard({ viva }: { viva: ProgressSnapshot["viva"] | undefined }) {
  return (
    <Section title="AI Viva">
      {viva ? (
        <>
          <p className="text-sm text-slate-700">Practice explaining what you know.</p>
          <p className="mt-3 text-sm text-slate-600">
            Last score: <span className="text-lg font-semibold tracking-tight text-slate-900">{Math.round(viva.lastScore)}%</span>
          </p>
          <p className="text-xs text-slate-500">
            {viva.subject}
            {viva.topic ? ` — ${viva.topic}` : ""}
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-700">Test your understanding with an AI Viva.</p>
      )}
      <div className="mt-4">
        <LinkButton to="/viva" size="sm">
          Start Viva
        </LinkButton>
      </div>
    </Section>
  );
}
