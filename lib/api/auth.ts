import type { SupabaseClient, User } from '@supabase/supabase-js';

/** Extract a `Bearer <token>` from request headers, if present. */
export function getBearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the authenticated user from the request, or null when the token is
 * missing, expired, or invalid. Users are scoped per tenant by `user.id`.
 */
export async function getRequestUser(
  supabase: SupabaseClient,
  headers: Headers,
): Promise<User | null> {
  const token = getBearerToken(headers);
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error ? null : data.user;
}
