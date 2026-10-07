# Roles and access (admin / student)

## What exists

| | Student | Admin |
|---|---|---|
| Uses the study app (Tutor, Notes, Quiz, Plan, Progress, Viva, Recommendations) | yes | yes |
| Sees the **Admin** menu and `/admin` screen | no | yes |
| Lists accounts (name, email, role, status) | no | yes |
| Pauses / restores a **student's** access | no | yes |
| Sees another person's notes, chats, quizzes or answers | **no** | **no** (the admin API returns account details only) |

* **Everyone who signs up is a student with access.** Signup stays open (decision: "open signup, admin can only revoke").
* **Pausing is reversible and deletes nothing.** A paused student's requests are refused with `403 access_revoked` on their very next request (the check runs in the database on every request, no cache), and the app shows one calm "Access paused" screen with a Sign out button. Restoring takes effect immediately.
* **An admin cannot pause themselves or another admin**, and the admin screen cannot create admins.
* Email OTP sign-in was **not** built (decision: skip for now). Password sign-in is unchanged.

## Where it lives

* Database (migration `0014_roles_and_access`, additive): `student_profiles.role` (`student|admin`, default `student`), `access_status` (`active|revoked`, default `active`), `access_changed_at`, `access_changed_by`, both with CHECK constraints. Existing rows became active students.
* A student can **read** their own row but can only **update** `display_name` and `timezone` (column-level grant). So a student cannot change their own role or access status, with or without a crafted request. Verified against the live database in `access/access.integration.test.ts`.
* API: `authenticate` looks the account up on every request; `requireAdmin` passes only when that lookup says `admin` (the token, headers, query and body are never used to decide). Routes: `GET /api/admin/students?q=`, `POST /api/admin/students/:id/access` with `{ "status": "active" | "revoked" }` and nothing else.
* Web: `AccessGate` (role + paused screen), `/admin` (`AdminPage`), Admin link in the menu for admins, a Student/Admin badge in Settings.

## Making the first admin (one time)

1. The person signs up in the app normally.
2. From the project folder run:

```bash
npm run admin:promote -w @copilot/api -- their.email@gmail.com
```

3. They sign out and in again; the **Admin** menu appears.

The script changes exactly one row, refuses an unknown email, and prints no secrets. After that, admins are created only the same way (there is deliberately no "make admin" button).

## Safety notes

* If the access lookup itself fails (database down), the request fails with an error - it never lets an unchecked account through.
* The admin lists fetch at most 500 rows and the screens show them 20 per page (Previous / Next); search narrows the list. Search text is treated as plain text (no wildcards).
* Logging records ids only (`admin_access_change`: who, which account, which status) - never names, emails or content.
* In `NODE_ENV=test` the app skips the access lookup unless a test injects an access repository (the many route tests use stubbed databases). In every other environment it is always on. This is unit-tested (`resolveAccessRepo`).

## Not built (ask if you want it)

* Gmail/email **OTP** sign-in, and an invite-only / approval-before-access mode.
* Promoting or demoting admins from the screen (admins are made with `npm run admin:promote`).

## Account menu, bug reports and audit log

* **Account menu** (bottom of the sidebar; the round badge in the top bar on phones): name, email, role, **Dark mode** switch, **Change password**, **Report a bug**, **Sign out**. Change password uses the auth service directly (`auth.updateUser`); the password never goes to our API or logs.
* **Report a bug** (menu item, and the bug icon in the top bar - everyone): a title and a description; only the screen path is attached. Saved server-side against the verified user; at most 10 reports per account per 24 hours. Table `bug_reports` (migration `0015`).
* **Admins only**: sidebar links **Bug reports** (inbox, Open/Resolved/All, mark resolved or reopen) and **Audit log** (newest first: who paused/restored whom, who resolved/reopened a report). Table `audit_log`, append-only, written in the same transaction as the change it records.
* Both tables are server-only: RLS on and no grants for `anon`/`authenticated` (verified against the live database). The audit log stores ids and status words only - never report text, names or emails (names are looked up when it is displayed).
