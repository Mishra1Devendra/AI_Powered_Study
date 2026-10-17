import { pgSchema, uuid } from "drizzle-orm/pg-core";

export { authUid, authenticatedRole } from "drizzle-orm/supabase";

// Supabase owns auth.users; only its referenced ID column is modeled here.
export const authUsers = pgSchema("auth").table("users", {
  id: uuid("id").primaryKey(),
});
