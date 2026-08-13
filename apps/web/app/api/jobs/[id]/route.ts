import { NextResponse } from 'next/server';
import { getRequestUser } from '@ingestio/lib/api/auth';
import { getSupabaseAdmin } from '@ingestio/lib/supabase/admin';
import type { JobStatusResponse } from '@ingestio/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/jobs/[id]
 *
 * Auth: Authorization: Bearer <supabase-access-token>
 * Returns the live row (progress is written by the worker on every step), or
 * 404 when the job doesn't exist / belongs to another user.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid job id' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const user = await getRequestUser(supabase, request.headers);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, status, progress, result_json, error, created_at, updated_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error(`[jobs] fetch failed for job ${id}: ${error.message}`);
    return NextResponse.json({ error: 'failed to fetch job' }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body: JobStatusResponse = {
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result_json,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
  return NextResponse.json(body);
}
