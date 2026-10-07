import { useState, type FormEvent } from "react";
import { MIN_PASSWORD_LENGTH, passwordSchema } from "@copilot/shared";
import { useAuth } from "../../auth/AuthProvider";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Dialog } from "../planner/Dialog";

type Errors = Partial<Record<"password" | "confirm", string>>;

/** Safe wording for the few things Supabase can say. Its own message is never shown. */
function friendly(message: string): string {
  const m = message.toLowerCase();
  if ((m.includes("same") || m.includes("different")) && m.includes("password")) return "Choose a password different from your current one.";
  if (m.includes("weak") || m.includes("pwned") || m.includes("compromised") || m.includes("strength")) return "That password is too easy to guess. Try a longer one with a mix of words, numbers and symbols.";
  if (m.includes("reauth") || m.includes("nonce") || m.includes("recent")) return "For your security, please sign out, sign in again, and then change your password.";
  if (m.includes("fetch") || m.includes("network")) return "Could not reach the server. Check your connection and try again.";
  return "Your password could not be changed. Please try again.";
}

/** Changes the signed-in person's own password through the auth service. The password is never stored, logged or sent anywhere else by this app. */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { client } = useAuth();
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    const parsed = passwordSchema.safeParse(password);
    const next: Errors = {};
    if (!parsed.success) next.password = parsed.error.issues[0]?.message ?? `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    else if (confirm !== password) next.confirm = "Passwords do not match";
    if (next.password || next.confirm) return setErrors(next);
    setErrors({});
    setSaving(true);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) setFormError(friendly(error.message));
      else setDone(true);
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Change password" onClose={onClose} busy={saving}>
      {done ? (
        <div className="space-y-4">
          <Alert tone="success">Your password was changed.</Alert>
          <Button onClick={onClose}>Close</Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {formError && <Alert tone="error">{formError}</Alert>}
          <Input label="New password" name="password" type="password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={errors.password} data-initial-focus="" />
          <Input label="Confirm new password" name="confirm" type="password" autoComplete="new-password" error={errors.confirm} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Change password
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
