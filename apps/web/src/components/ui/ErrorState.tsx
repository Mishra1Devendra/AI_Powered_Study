import type { ReactNode } from "react";
import { Button } from "./Button";

/**
 * The one way an API-driven section says "that did not work": a calm sentence a student understands and a Retry button.
 * Pass a message from `friendlyMessage(err)` - never a raw exception.
 */
export function ErrorState({ message, onRetry, retryLabel = "Try again", compact = false, children }: { message: string; onRetry?: (() => void) | undefined; retryLabel?: string; compact?: boolean; children?: ReactNode }) {
  return (
    <div role="alert" className={`rounded-xl bg-red-50 text-red-900 ring-1 ring-red-200 ${compact ? "px-4 py-3" : "px-5 py-6 text-center"}`}>
      <p className="text-sm font-medium">{message}</p>
      {children && <div className="mt-1 text-sm">{children}</div>}
      {onRetry && (
        <Button variant="secondary" className={`h-10 ${compact ? "mt-2" : "mt-4"}`} onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
