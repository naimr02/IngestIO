import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

/**
 * Browser-side Supabase client (anon key only — safe to ship to the client).
 *
 * Used by the dashboard's "Use demo key" flow to create an anonymous session
 * (`auth.signInAnonymously`) whose access token then authenticates the upload
 * and status API routes.
 *
 * Returns null when the public env vars aren't configured (e.g. local builds
 * without a `.env` file), so callers can hide the demo entry point.
 */
export function getBrowserSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}
