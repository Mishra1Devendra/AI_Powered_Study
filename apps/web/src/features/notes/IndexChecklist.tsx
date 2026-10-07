import type { Note } from "@copilot/shared";
import { Spinner } from "../../components/ui/Spinner";

type Step = "done" | "active" | "pending" | "failed";

function Row({ step, children }: { step: Step; children: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
        {step === "active" ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${step === "done" ? "text-emerald-600" : step === "failed" ? "text-red-600" : "text-slate-300"}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {step === "done" ? <path d="M3 8.5l3.2 3L13 4.5" /> : step === "failed" ? <path d="M4 4l8 8M12 4l-8 8" /> : <circle cx="8" cy="8" r="3" />}
          </svg>
        )}
      </span>
      <span className={step === "pending" ? "text-slate-500" : step === "failed" ? "text-red-800" : "text-slate-800"}>
        {children}
      </span>
    </li>
  );
}

/**
 * What has really happened to a document, in the student's words. Every line comes from the document's actual
 * processing status - there are no fake percentages and nothing is ticked before it is true. Searching is by keyword
 * (no embedding model is used), so "Indexed" means the text is stored and searchable.
 */
export function IndexChecklist({ note, compact = false }: { note: Pick<Note, "status" | "indexed" | "error">; compact?: boolean }) {
  const indexed = note.indexed ?? note.status === "ready";
  const rows: Array<[Step, string]> =
    note.status === "uploading"
      ? [["active", "Uploading your file…"], ["pending", "Extract text"], ["pending", "Create knowledge index"]]
      : note.status === "processing"
        ? [["done", "Uploaded"], ["active", "Extracting text and creating the knowledge index…"], ["pending", "Ready for AI questions"]]
        : note.status === "failed"
          ? [["done", "Uploaded"], ["failed", "We couldn't prepare this document."]]
          : [["done", "Uploaded"], ["done", "Text extracted"], [indexed ? "done" : "pending", "Indexed"]];

  return (
    <div className="text-sm">
      {note.status === "processing" && <p className="mb-1.5 font-medium text-slate-800">Preparing your study material…</p>}
      <ul aria-label="Document preparation" className={compact ? "flex flex-wrap gap-x-4 gap-y-1" : "space-y-1.5"}>
        {rows.map(([step, text]) => (
          <Row key={text} step={step}>
            {text}
          </Row>
        ))}
      </ul>
      {note.status === "ready" && indexed && <p className="mt-2 font-medium text-emerald-800">{"✓"} AI-ready: AI can now answer questions from this document.</p>}
    </div>
  );
}
