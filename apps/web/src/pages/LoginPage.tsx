import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { loginInputSchema } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { AuthLayout } from "../components/layout/AuthLayout";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

type Errors = Partial<Record<"email" | "password", string>>;

/** What the page learned from the confirmation link the student clicked in their email (nothing here is trusted or stored). */
export function confirmationNotice(search: string, hash: string): { tone: "success" | "error"; text: string } | null {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  const queryParams = new URLSearchParams(search);
  // Supabase reports a bad or expired link in the hash (older flow) or the query string (the flow this app uses).
  const failed = ["error", "error_code", "error_description"].some((k) => hashParams.get(k) || queryParams.get(k));
  if (failed) {
    return { tone: "error", text: "That confirmation link is invalid or has expired. Sign in below, or create your account again to get a new link." };
  }
  if (queryParams.get("confirmed") === "1") {
    return { tone: "success", text: "Your email is confirmed. Please sign in with your email and password to continue." };
  }
  return null;
}

export default function LoginPage() {
  const { signIn } = useAuth();
  const [params] = useSearchParams();
  const notice = confirmationNotice(`?${params.toString()}`, typeof window === "undefined" ? "" : window.location.hash);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const form = new FormData(e.currentTarget);
    const parsed = loginInputSchema.safeParse({ email: form.get("email"), password: form.get("password") });
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({ email: fieldErrors.email?.[0], password: fieldErrors.password?.[0] });
      return;
    }
    setErrors({});
    setSubmitting(true);
    const result = await signIn(parsed.data);
    setSubmitting(false);
    // On success the auth state changes and <PublicOnlyRoute> redirects automatically.
    if (!result.ok) setFormError(result.message);
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to continue your study session.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {notice && !formError && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {formError && (
          <div key={formError} className="animate-shake">
            <Alert tone="error">{formError}</Alert>
          </div>
        )}
        <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" error={errors.email} />
        <Input label="Password" name="password" type="password" autoComplete="current-password" error={errors.password} />
        <Button type="submit" loading={submitting} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        New here?{" "}
        <Link to="/signup" className="font-medium text-brand-600 hover:text-brand-700">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
