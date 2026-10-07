import { sql } from "drizzle-orm";
import { EnvError, loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";

/**
 * Read-only verification of the signup flow. Reports:
 *  - whether Supabase email confirmation is currently disabled (mailer_autoconfirm)
 *  - each auth user: confirmed without an email link? profile row linked? name matches metadata?
 * Emails are masked and nothing is modified.
 */
async function main() {
  const env = loadEnv();

  const settings = await fetch(`${env.SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.SUPABASE_ANON_KEY ?? "" },
  }).then((r) => r.json() as Promise<{ mailer_autoconfirm?: boolean }>);
  const autoconfirm = settings.mailer_autoconfirm === true;
  console.log(
    `${autoconfirm ? "OK  " : "WARN"}  Email confirmation is ${autoconfirm ? "DISABLED (signup logs in immediately)" : "ENABLED - turn off 'Confirm email' in Supabase to skip the email link"}`,
  );

  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const rows = await db.execute<{
      id: string;
      email: string;
      confirmed: boolean;
      created_at: string;
      has_profile: boolean;
      profile_name: string | null;
      meta_name: string | null;
    }>(sql`
      select u.id::text, u.email,
             (u.email_confirmed_at is not null) as confirmed,
             to_char(u.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at,
             (p.id is not null) as has_profile,
             p.display_name as profile_name,
             u.raw_user_meta_data ->> 'display_name' as meta_name
      from auth.users u
      left join public.student_profiles p on p.id = u.id
      order by u.created_at desc
      limit 20
    `);
    if (rows.length === 0) console.log("      No auth users yet.");
    for (const r of rows) {
      const [local = "", domain = ""] = r.email.split("@");
      const masked = `${local.slice(0, 2)}***@${domain}`;
      const linked = r.has_profile && r.profile_name === r.meta_name;
      console.log(
        `      ${linked ? "OK  " : "FAIL"}  ${masked}  created=${r.created_at}  confirmed=${r.confirmed}  profile=${r.has_profile ? "linked" : "MISSING"}  name="${r.profile_name ?? ""}"`,
      );
      if (!linked) process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof EnvError ? err.message : "check:signup failed unexpectedly.");
  process.exit(1);
});
