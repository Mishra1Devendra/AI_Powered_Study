import { MIN_PASSWORD_LENGTH } from "@copilot/shared";

/** A quick, honest guide for the person typing: length first, then variety. It never blocks signup (the server rule is the length). */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!pw) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= MIN_PASSWORD_LENGTH) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const capped = (pw.length < MIN_PASSWORD_LENGTH ? Math.min(score, 1) : score) as 0 | 1 | 2 | 3 | 4;
  return { score: capped, label: ["Too short", "Weak", "Fair", "Good", "Strong"][pw.length < MIN_PASSWORD_LENGTH ? 0 : Math.max(1, capped)]! };
}

const COLORS = ["bg-slate-300", "bg-red-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-600"];

export function PasswordStrength({ value }: { value: string }) {
  const { score, label } = passwordStrength(value);
  if (!value) return null;
  return (
    <div className="-mt-2" aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i <= score ? COLORS[score] : "bg-slate-200"}`} />
        ))}
      </div>
      <p className="mt-1 text-xs text-slate-600">Password strength: {label}</p>
    </div>
  );
}
