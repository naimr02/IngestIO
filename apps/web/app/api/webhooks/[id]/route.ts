import { NextResponse } from 'next/server';
import { getRequestUser } from '@ingestio/lib/api/auth';
import { getSupabaseAdmin } from '@ingestio/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DELETE /api/webhooks/:id — delete a webhook endpoint */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid webhook id' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const user = await getRequestUser(supabase, request.headers);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Delete only if owned by this user (RLS would enforce, but explicit is clearer)
  const { error } = await supabase
    .from('webhooks')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error(`[webhooks] delete failed for user ${user.id}, id ${id}: ${error.message}`);
    return NextResponse.json({ error: 'failed to delete webhook' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
