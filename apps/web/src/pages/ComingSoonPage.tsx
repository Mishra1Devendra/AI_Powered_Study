import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { SparkIcon } from "../components/ui/Icons";

/** Honest placeholder for areas whose features are not built yet (no fake data). */
export default function ComingSoonPage({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="animate-fade-up">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card className="mt-6">
        <EmptyState title="Not built yet" icon={<SparkIcon />}>
          {title} arrives in Phase {phase} of the build.
        </EmptyState>
      </Card>
    </div>
  );
}
