import { z } from "zod";
import { roleSchema } from "./admin.js";

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(80, "Name must be 80 characters or fewer");

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const profileSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  timezone: z.string(),
  /** Missing means "student" (older responses and fixtures). */
  role: roleSchema.optional(),
});

export const meResponseSchema = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string().nullable() }),
  profile: profileSchema,
});

export const updateProfileInputSchema = z
  .object({ displayName: displayNameSchema, timezone: timezoneSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type Profile = z.infer<typeof profileSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
