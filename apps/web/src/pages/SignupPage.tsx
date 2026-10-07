import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { MIN_PASSWORD_LENGTH, signupInputSchema } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { AuthLayout } from "../components/layout/AuthLayout";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { PasswordStrength } from "../components/ui/PasswordStrength";

type Errors = Partial<Record<"displayName" | "email" | "password" | "confirmPassword", string>>;

export default function SignupPage() {
  const { signUp } = useAuth();
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);
  const [pw, setPw] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const form = new FormData(e.currentTarget);
    const parsed = signupInputSchema.safeParse({
      displayName: form.get("displayName"),
      email: form.get("email"),
      password: form.get("password"),
      confirmPassword: form.get("confirmPassword"),
    });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      setErrors({
        displayName: f.displayName?.[0],
        email: f.email?.[0],
        password: f.password?.[0],
        confirmPassword: f.confirmPassword?.[0],
      });
      return;
    }
    setErrors({});
    setSubmitting(true);
    const result = await signUp(parsed.data);
    setSubmitting(false);
    if (!result.ok) return setFormError(result.message);
    // If no confirmation is required, a session now exists and <PublicOnlyRoute> redirects.
    if (result.needsEmailConfirmation) setConfirmEmail(parsed.data.email);
  }

  if (confirmEmail) {
    return (
      <AuthLayout title="Check your email" subtitle="One more step to activate your account.">
        <Alert tone="success">
          If <strong>{confirmEmail}</strong> can be registered, we have sent a confirmation link. Open it to finish signing up.
        </Alert>
        <p className="mt-4 text-sm text-slate-600">After you click the link you may land on the sign-in page: that is normal. Your email is then confirmed, so just sign in with your email and password. (Opening the link in the same browser you signed up in signs you in automatically.)</p>
        <p className="mt-6 text-center text-sm text-slate-600">
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Back to sign in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="Start learning with a personal AI study partner.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <div key={formError} className="animate-shake">
            <Alert tone="error">{formError}</Alert>
          </div>
        )}
        <Input label="Your name" name="displayName" autoComplete="name" error={errors.displayName} />
        <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" error={errors.email} />
        <Input
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={errors.password}
          onChange={(e) => setPw(e.target.value)}
        />
        <PasswordStrength value={pw} />
        <Input
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword}
        />
        <Button type="submit" loading={submitting} className="w-full">
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
