import { defineConfig } from "drizzle-kit";

// Safety: only `generate` + `migrate` are exposed via npm scripts. `drizzle-kit push`
// and `drop` are intentionally NOT wired up - they can alter or drop existing objects.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  // Only manage our own `public` objects; never touch Supabase's `auth`/`storage` schemas.
  schemaFilter: ["public"],
  // Supabase already provides the anon/authenticated/service_role roles.
  entities: { roles: { provider: "supabase" } },
  strict: true,
  verbose: true,
});
