# Authentication and data isolation (Phase 1)

## Design

| Concern | Where it lives |
|---|---|
| Passwords, email, sessions, token refresh, email confirmation | **Supabase Auth** (`auth.users`). We store no passwords and run no custom session system. |
| Student profile data | `public.student_profiles` (one row per auth user, same `id`). Separate from credentials. |
| Browser | `@supabase/supabase-js`, public anon key, PKCE flow, session persisted by the SDK, tokens auto-refreshed. |
| API | Fastify verifies the `Authorization: Bearer <access token>` locally against the project's public JWKS (ES256) using `jose`. Checks signature, expiry, issuer, audience and `role=authenticated`. The anon key is rejected. |
| Isolation | **Row Level Security** on `student_profiles` plus `withUser()` on the API, which runs each query as role `authenticated` with `auth.uid()` set, so the database enforces isolation even if a query forgets a filter. |

Request flow: browser signs in with Supabase, then calls `/api/*` with the access token. The API derives the user id **only** from the verified token and never from the URL or body.

## Database objects (migrations in `apps/api/drizzle/`)

- `0000_student_profiles`: table, check constraint, FK to `auth.users` with `ON DELETE CASCADE`, RLS enabled, policies `select_own` and `update_own` (role `authenticated`).
- `0001_profile_trigger_and_grants`: least-privilege grants (anon: none; authenticated: SELECT, plus UPDATE on `display_name` and `timezone` only), `updated_at` trigger, and `on_auth_user_created` which creates the profile row on signup (works for email now and OAuth later). The trigger function is `SECURITY DEFINER` with an empty `search_path` and is not callable by API clients.

Both migrations are additive. Only `generate` and `migrate` are exposed as npm scripts; `push` and `drop` are not.

## Security properties and their tests

| Property | Test |
|---|---|
| Forged, expired, wrong-key, wrong-issuer/audience, anon, `alg=none` tokens rejected | `apps/api/src/auth/verify-token.test.ts` |
| API returns 401 without a valid token; ignores client-supplied ids | `apps/api/src/routes/me.test.ts` |
| User A cannot read or update user B; cannot change `id` or protected columns; no client INSERT/DELETE; anon gets nothing; signup trigger not callable | `apps/api/src/db/rls.integration.test.ts` (live DB, always rolled back) |
| Signed-out users cannot reach any app route; session restore; login, signup and logout flows | `apps/web/src/auth/auth-flow.test.tsx` |
| No secrets in the browser bundle | Vite `define` allowlist exposes only `SUPABASE_URL` and `SUPABASE_ANON_KEY` |

## Browser session storage (known trade-off)

supabase-js keeps the session in `localStorage`. This is the standard SPA setup, but an XSS bug could read it. Mitigations: React escapes output, no `dangerouslySetInnerHTML`, and a strict Content-Security-Policy will be added in Phase 10 hardening. Moving to httpOnly cookies would need a backend-for-frontend session layer and is not planned.

## Google OAuth later

Enable the Google provider in the Supabase dashboard and call `supabase.auth.signInWithOAuth({ provider: "google" })` from `AuthProvider`. No schema change is needed because the signup trigger already reads `full_name` and `name` metadata.

## Development signup flow (email confirmation OFF)

Signup form: **name, email, password, confirm password**. With Supabase "Confirm email" turned off, `signUp` returns a session immediately, the app redirects to the dashboard, and the `on_auth_user_created` trigger has already created the linked `student_profiles` row (name taken from the `display_name` user metadata). If confirmation is still enabled, the app falls back to a "Check your email" screen instead of failing.

> **Development only.** Re-enable "Confirm email" before real users sign up, otherwise anyone can register with an email address they do not own. With confirmation off, signing up with an existing email returns an explicit "already exists" error, a small account-enumeration trade-off that is acceptable in development.

## Supabase dashboard settings you control (cannot be set from code)

1. **Authentication, Sign In / Providers, Email:** turn **off** "Confirm email" (development). Verify with `npm run check:signup`, which prints whether confirmation is disabled.
2. **Authentication, URL Configuration:** set **Site URL** to `http://localhost:5173` and add `http://localhost:5173/**` to **Redirect URLs** (needed when confirmation is re-enabled).
3. **Authentication, Password policy:** the UI requires 10 or more characters. Match this server-side by raising the minimum password length to 10.

## Manual end-to-end checklist (live accounts)

Run `npm run dev`, then open http://localhost:5173/signup.

1. Sign up with name, email, password and confirm password. Expect an immediate redirect to the dashboard ("Good …, <your name>") with no email step.
2. Run `npm run check:signup`. Expect `confirmed=true`, `profile=linked`, and your name.
3. Sign out. Expect the login page, and `/dashboard` to redirect back to login.
4. Log in again with email and password. Expect the dashboard.
5. Reload the page. Expect to stay signed in.
6. In Settings, change the display name, save, reload. Expect it to persist.
