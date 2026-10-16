import { AiUsageNote } from "../features/ai-usage/AiUsageNote";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { updateProfileInputSchema, type HealthResponse } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Input } from "../components/ui/Input";
import { SkeletonRegion, Skeleton } from "../components/ui/Skeleton";
import { clearResume } from "../features/continue/resumeStore";
import { useProfile } from "../features/profile/useProfile";
import { updateProfile } from "../lib/api";
import { fetchHealth } from "../lib/tutorApi";
import { useTheme, type ThemePreference } from "../lib/theme";

const field = "block h-11 w-full rounded-xl bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 transition focus:outline-none focus:ring-2 focus:ring-brand-600";

function timeZones(current: string): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

/** What answers the student's questions, in plain words. Reads the public health probe: no AI request is made. */
function AiStatus() {
  const [health, setHealth] = useState<HealthResponse | null | "error">(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then(setHealth)
      .catch(() => !controller.signal.aborted && setHealth("error"));
    return () => controller.abort();
  }, []);
  return (
    <Card className="mt-6">
      <h2 className="text-base font-semibold">AI &amp; privacy</h2>
      {health === null && (
        <SkeletonRegion label="Checking the AI status" className="mt-3 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </SkeletonRegion>
      )}
      {health === "error" && <p className="mt-2 text-sm text-slate-700">The AI status couldn&apos;t be checked right now. Your notes, quizzes and progress still work.</p>}
      {health && health !== "error" && (
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">AI helper</dt>
            <dd className="text-right font-medium text-slate-900">{health.ai.provider === "disabled" ? "AI disabled" : health.ai.isMock ? "Demo AI (mock)" : health.ai.provider === "free-ai" ? "Google Gemini · online" : `AI · ${health.ai.model}`}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Where it runs</dt>
            <dd className="text-right font-medium text-slate-900">{health.ai.provider === "disabled" ? "Disabled; no external AI requests" : health.ai.isMock ? "Built into the app" : "Google Gemini (online)"}</dd>
          </div>
        </dl>
      )}
      {health && health !== "error" && health.ai.isMock && <p className="mt-3 text-sm text-slate-600">This environment is using canned demo text, labelled as demo.</p>}
      <p className="mt-3 text-sm leading-relaxed text-slate-600">
        AI is disabled for this deployment, so prompts and study content are not currently sent to an AI provider. If Gemini is enabled later after model eligibility is verified, relevant prompts and study content may be sent to Google. Google's terms for unpaid Gemini API use say submitted content may be used to improve products and may be reviewed by humans. Avoid including sensitive personal information. The app will not switch to another provider.
      </p>
    </Card>
  );
}

const THEME_CHOICES: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark, until you change it" },
  { value: "system", label: "Device", hint: "Follow this device's setting" },
];

/** Light / dark choice. Saved on this device and kept across visits and sign-ins until changed. */
function Appearance() {
  const { preference, setPreference } = useTheme();
  return (
    <Card className="mt-6">
      <h2 className="text-base font-semibold">Appearance</h2>
      <p className="mt-1 text-sm text-slate-600">Your choice is remembered on this device, including after you sign out.</p>
      <div role="radiogroup" aria-label="Theme" className="mt-3 grid gap-2 sm:grid-cols-3">
        {THEME_CHOICES.map((c) => {
          const on = preference === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPreference(c.value)}
              className={`min-h-11 rounded-xl px-3 py-2 text-left text-sm ring-1 transition ${on ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
            >
              <span className="block font-medium">{c.label}</span>
              <span className="block text-xs text-slate-600">{c.hint}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const { client, user, signOut } = useAuth();
  const navigate = useNavigate();
  const { state, setProfile, reload } = useProfile();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const current = state.status === "ready" ? state.me.profile.timezone : "UTC";
  const zones = useMemo(() => timeZones(current), [current]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const form = new FormData(e.currentTarget);
    const parsed = updateProfileInputSchema.safeParse({ displayName: form.get("displayName"), timezone: form.get("timezone") });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Please check the form.");
    setError(null);
    setSaving(true);
    try {
      setProfile(await updateProfile(client, parsed.data));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-up max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-slate-600">Your account, your study preferences and how the AI works.</p>

      <Card className="mt-6">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          Profile
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200">{state.status === "ready" && state.me.profile.role === "admin" ? "Admin" : "Student"}</span>
        </h2>
        {state.status === "loading" && (
          <SkeletonRegion label="Loading your profile" className="mt-4 space-y-3">
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </SkeletonRegion>
        )}
        {state.status === "error" && (
          <div className="mt-4">
            <ErrorState message={state.message} onRetry={() => void reload()} />
          </div>
        )}
        {state.status === "ready" && (
          <form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            {saved && <Alert tone="success">Profile saved.</Alert>}
            <Input label="Email" value={user?.email ?? ""} readOnly disabled hint="Your sign-in email is managed by your account." />
            <Input label="Display name" name="displayName" defaultValue={state.me.profile.displayName} maxLength={80} autoComplete="name" />
            <div>
              <label htmlFor="timezone" className="mb-1.5 block text-sm font-medium text-slate-700">
                Time zone
              </label>
              <select id="timezone" name="timezone" defaultValue={state.me.profile.timezone} aria-describedby="timezone-hint" className={field}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <p id="timezone-hint" className="mt-1.5 text-sm text-slate-600">
                Decides what &ldquo;today&rdquo; means for your study plan, streak and progress.
              </p>
            </div>
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </form>
        )}
      </Card>

      <Appearance />

      <AiStatus />
      <Card className="mt-6">
        <h2 className="text-base font-semibold">AI use today</h2>
        <p className="mt-1 text-sm text-slate-600">When AI is enabled, account-level daily limits apply to AI requests. Reading, studying cards and taking quizzes do not make AI requests. AI is currently unavailable while the approved Gemini free-tier model is unverified.</p>
        <AiUsageNote className="mt-3" />
      </Card>

      <Card className="mt-6">
        <h2 className="text-base font-semibold">About</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">AI Student Copilot: learn with an AI tutor, practise with quizzes and vivas, plan your study and track your progress — one connected loop built on your own material.</p>
      </Card>

      <Card className="mt-6">
        <h2 className="text-base font-semibold">Session</h2>
        <p className="mt-1 text-sm text-slate-600">Sign out of this device.</p>
        <Button
          variant="secondary"
          className="mt-4"
          onClick={async () => {
            clearResume();
            await signOut();
            navigate("/login", { replace: true });
          }}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}
