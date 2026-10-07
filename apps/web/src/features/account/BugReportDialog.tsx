import { useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import { BUG_DESCRIPTION_MAX, BUG_SEVERITY_LABEL, BUG_TITLE_MAX, BUG_TYPE_LABEL, createBugReportInputSchema, type BugSeverity, type BugType } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Dialog } from "../planner/Dialog";
import { submitBugReport } from "../../lib/adminApi";
import { friendlyMessage } from "../../lib/errors";

/** "Report a bug": a short title and what happened. Only the screen's path is attached (no query string, no content). */
export function BugReportDialog({ onClose }: { onClose: () => void }) {
  const { client } = useAuth();
  const { pathname } = useLocation();
  const [errors, setErrors] = useState<{ title?: string | undefined; description?: string | undefined }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const form = new FormData(e.currentTarget);
    const parsed = createBugReportInputSchema.safeParse({ title: form.get("title"), description: form.get("description"), page: pathname, type: form.get("type"), severity: form.get("severity") });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      setErrors({ title: f.title?.[0], description: f.description?.[0] });
      return;
    }
    setErrors({});
    setSending(true);
    try {
      await submitBugReport(client, parsed.data);
      setSent(true);
    } catch (err) {
      setFormError(friendlyMessage(err, "Your report could not be sent. Please try again in a moment."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog title="Report a bug" onClose={onClose} busy={sending}>
      {sent ? (
        <div className="space-y-4">
          <Alert tone="success">Thank you - your report was sent to the administrators.</Alert>
          <Button onClick={onClose}>Close</Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <p className="text-sm text-slate-600">Tell us what went wrong. We only attach the screen you are on ({pathname}) - never your notes, chats or answers.</p>
          {formError && <Alert tone="error">{formError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="bug-type" className="mb-1.5 block text-sm font-medium text-slate-700">
                What is it?
              </label>
              <select id="bug-type" name="type" defaultValue="bug" className="block h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600">
                {(Object.keys(BUG_TYPE_LABEL) as BugType[]).map((t) => (
                  <option key={t} value={t}>
                    {t === "feature" ? "A feature request" : BUG_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bug-severity" className="mb-1.5 block text-sm font-medium text-slate-700">
                How serious is it?
              </label>
              <select id="bug-severity" name="severity" defaultValue="medium" className="block h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600">
                {(Object.keys(BUG_SEVERITY_LABEL) as BugSeverity[]).map((s) => (
                  <option key={s} value={s}>
                    {BUG_SEVERITY_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Input label="Short title" name="title" maxLength={BUG_TITLE_MAX} error={errors.title} data-initial-focus="" />
          <div>
            <label htmlFor="bug-description" className="mb-1.5 block text-sm font-medium text-slate-700">
              What happened?
            </label>
            <textarea
              id="bug-description"
              name="description"
              rows={5}
              maxLength={BUG_DESCRIPTION_MAX}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={errors.description ? "bug-description-error" : undefined}
              className={`block w-full rounded-xl bg-white px-3.5 py-2.5 text-sm text-slate-900 ring-1 transition focus:outline-none focus:ring-2 ${errors.description ? "ring-red-400 focus:ring-red-500" : "ring-slate-300 focus:ring-brand-600"}`}
            />
            {errors.description && (
              <p id="bug-description-error" className="mt-1.5 text-sm text-red-700">
                {errors.description}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" loading={sending}>
              Send report
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
