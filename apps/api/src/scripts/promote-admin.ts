import { sql } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";

/**
 * One-time bootstrap: makes an EXISTING account an administrator.
 *   npm run admin:promote -w @copilot/api -- someone@gmail.com
 *
 * The person must have signed up first. This is the only way to create the first admin; after that the admin screen manages
 * student access (it cannot create admins). It changes exactly one row's `role`, deletes nothing, and prints no secrets.
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: npm run admin:promote -w @copilot/api -- someone@gmail.com");
    process.exitCode = 1;
    return;
  }
  const { db, close } = createDb(loadEnv().DATABASE_URL);
  try {
    const found = (await db.execute(sql`select p.id, p.role from public.student_profiles p join auth.users u on u.id = p.id where lower(u.email) = ${email}`)) as unknown as Array<{ id: string; role: string }>;
    const account = found[0];
    if (!account) {
      console.error("No account with that email. Sign up in the app first, then run this again.");
      process.exitCode = 1;
      return;
    }
    if (account.role === "admin") {
      console.log("That account is already an administrator. Nothing changed.");
      return;
    }
    await db.execute(sql`update public.student_profiles set role = 'admin', access_status = 'active', access_changed_at = now() where id = ${account.id}`);
    console.log("Done: that account is now an administrator. They may need to sign out and in again to see the Admin menu.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message.slice(0, 200) : "unknown error");
  process.exitCode = 1;
});
