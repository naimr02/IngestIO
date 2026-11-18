import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getRequestUser } from '@ingestio/lib/api/auth';
import { getSupabaseAdmin } from '@ingestio/lib/supabase/admin';
import { WEBHOOK_EVENT_TYPES, validateWebhookEventType } from '@ingestio/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateSecretKey(): string {
  return randomBytes(32).toString('hex');
}

function assertHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('target_url must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('target_url must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('target_url must use http(s)');
  }
  return value;
}

/** GET /api/webhooks — list user's webhook endpoints */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();
  const user = await getRequestUser(supabase, request.headers);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('webhooks')
    .select('id, target_url, event_type, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(`[webhooks] list failed for user ${user.id}: ${error.message}`);
    return NextResponse.json({ error: 'failed to list webhooks' }, { status: 500 });
  }

  return NextResponse.json({ webhooks: data ?? [] });
}

/** POST /api/webhooks — register a new webhook endpoint */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();
  const user = await getRequestUser(supabase, request.headers);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  const { target_url, event_type } = body as Record<string, unknown>;

  let validatedUrl: string;
  let validatedEvent: typeof WEBHOOK_EVENT_TYPES[number];

  try {
    validatedUrl = assertHttpUrl(target_url);
    validatedEvent = validateWebhookEventType(event_type);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'invalid input' }, { status: 400 });
  }

  const secretKey = generateSecretKey();

  const { data, error } = await supabase
    .from('webhooks')
    .insert({
      user_id: user.id,
      target_url: validatedUrl,
      secret_key: secretKey,
      event_type: validatedEvent,
    })
    .select('id, target_url, event_type, created_at, updated_at')
    .single();

  if (error) {
    // Unique constraint violation = duplicate (user, event_type, target_url)
    if (error.code === '23505') {
      return NextResponse.json({ error: 'webhook already exists for this URL and event' }, { status: 409 });
    }
    console.error(`[webhooks] insert failed for user ${user.id}: ${error.message}`);
    return NextResponse.json({ error: 'failed to create webhook' }, { status: 500 });
  }

  // Return secret_key ONLY on creation — never again
  return NextResponse.json({ ...data, secret_key: secretKey }, { status: 201 });
}
