import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUid, authUsers, authenticatedRole } from "./auth.js";

/**
 * Student profile data, kept separate from authentication.
 * Credentials, email and sessions live in Supabase Auth (`auth.users`) - never here.
 * One row per auth user, created automatically by the `on_auth_user_created` trigger.
 *
 * Row Level Security: a signed-in user can read and update only their own row.
 * No INSERT/DELETE for clients (the trigger inserts; deletion cascades from auth.users).
 */
export const studentProfiles = pgTable(
  "student_profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /** "student" (default) or "admin". Never editable by a client: students may only update display_name and timezone. */
    role: text("role").notNull().default("student"),
    /** "active" or "revoked". An admin can pause a student's access and restore it; nothing is deleted. */
    accessStatus: text("access_status").notNull().default("active"),
    accessChangedAt: timestamp("access_changed_at", { withTimezone: true }),
    accessChangedBy: uuid("access_changed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("student_profiles_role_valid", sql`${t.role} in ('student', 'admin')`),
    check("student_profiles_access_status_valid", sql`${t.accessStatus} in ('active', 'revoked')`),
    check("student_profiles_display_name_len", sql`char_length(btrim(${t.displayName})) between 1 and 80`),
    pgPolicy("student_profiles_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.id}`,
    }),
    pgPolicy("student_profiles_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.id}`,
      withCheck: sql`${authUid} = ${t.id}`,
    }),
  ],
).enableRLS();

export type StudentProfile = typeof studentProfiles.$inferSelect;
