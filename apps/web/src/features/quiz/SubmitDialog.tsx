import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  total: number;
  answered: number;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Close the dialog and jump to the first question without an answer. */
  onReviewUnanswered?: () => void;
}

/** Confirms a submission: says exactly what will happen to unanswered questions, traps focus, closes on Escape. */
export function SubmitDialog({ total, answered, submitting, error, onCancel, onConfirm, onReviewUnanswered }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const unanswered = total - answered;

  useEffect(() => {
    const previous = opener.current as HTMLElement | null;
    // Focus the safe choice (keep working), not the irreversible one.
    ref.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !submitting) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onCancel()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900">
          Submit your quiz?
        </h2>
        <p className="mt-2 text-sm text-slate-700">
          You&apos;ve answered <strong>{answered}</strong> of <strong>{total}</strong> questions.
        </p>
        {unanswered > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {unanswered} {unanswered === 1 ? "question is" : "questions are"} unanswered and will count as incorrect.
          </p>
        )}
        <p className="mt-2 text-sm text-slate-600">You can&apos;t change your answers after submitting, but you can retry the quiz.</p>
        {error && (
          <div className="mt-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={submitting} data-initial-focus>
            Keep working
          </Button>
          {unanswered > 0 && onReviewUnanswered && (
            <Button variant="secondary" onClick={onReviewUnanswered} disabled={submitting}>
              Review unanswered
            </Button>
          )}
          <Button onClick={onConfirm} loading={submitting}>
            {error ? "Try again" : "Submit quiz"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
