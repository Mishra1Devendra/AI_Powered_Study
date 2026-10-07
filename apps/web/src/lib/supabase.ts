import { GoTrueClient } from "@supabase/auth-js";
import type { SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * The sign-in half of a Supabase client, configured exactly as `createClient` would configure it (same URL, headers, PKCE flow,
 * session persistence, token refresh, and the SAME storage key, so people who are already signed in stay signed in).
 *
 * This app uses Supabase for authentication only; every piece of study data goes through our own API. The full client also bundles
 * a database, file-storage and realtime client (about 40% of the JavaScript the browser has to download), so they are left out.
 * `lib/supabase-usage.test.ts` fails if any code ever reaches for anything other than `.auth`.
 */
export function createAuthOnlyClient(supabaseUrl: string, publicKey: string): SupabaseClient {
  const base = new URL(supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`);
  const auth = new GoTrueClient({
    url: new URL("auth/v1", base).href,
    headers: { Authorization: `Bearer ${publicKey}`, apikey: publicKey },
    storageKey: `sb-${base.hostname.split(".")[0]}-auth-token`,
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  });
  return { auth } as unknown as SupabaseClient;
}

/**
 * Browser auth client. Uses ONLY the public anon key; the service-role key never reaches the frontend.
 * Data access is limited by Row Level Security and our API, not by hiding this key.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured ? createAuthOnlyClient(url, anonKey) : null;
