import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client, shared by the web API routes and the worker.
 *
 * Bypasses RLS — never import this into browser code and never expose the
 * service-role key to the client.
 */
export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — see .env.example',
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Idempotently ensure a private storage bucket exists (first-run convenience —
 * avoids a manual "create bucket" step in the Supabase dashboard).
 */
export async function ensureStorageBucket(supabase: SupabaseClient, bucket: string): Promise<void> {
  const { data } = await supabase.storage.getBucket(bucket);
  if (data) return;

  const { error } = await supabase.storage.createBucket(bucket, { public: false });
  if (error) {
    throw new Error(`failed to create storage bucket "${bucket}": ${error.message}`);
  }
}
