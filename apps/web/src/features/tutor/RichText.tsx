import { Suspense, lazy } from "react";
import type { SourceRef } from "@copilot/shared";

// Markdown + KaTeX are loaded on demand so the dashboard and login pages stay light.
const Markdown = lazy(() => import("./Markdown"));

/** Tutor text as Markdown. While the renderer loads, the text is shown as-is (never blank). */
export function RichText({ text, sources, onSource }: { text: string; sources?: SourceRef[]; onSource?: (source: SourceRef) => void }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap break-words">{text}</div>}>
      <Markdown sources={sources} onSource={onSource}>{text}</Markdown>
    </Suspense>
  );
}
