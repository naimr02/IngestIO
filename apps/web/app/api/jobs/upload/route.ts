import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getRequestUser } from '@ingestio/lib/api/auth';
import { enforceUploadRateLimit } from '@ingestio/lib/rate-limit';
import { enqueueExtraction } from '@ingestio/lib/queue/docQueue';
import { ensureStorageBucket, getSupabaseAdmin } from '@ingestio/lib/supabase/admin';
import type { UploadJobResponse } from '@ingestio/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
/** Matches the Gemini inline_data ceiling (20 MB). */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/jobs/upload
 *
 * Multipart body: { file: <PDF> }
 * Auth: Authorization: Bearer <supabase-access-token>
 *
 * 202 { job_id, status: 'pending' } on success (job is now queued).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = getSupabaseAdmin();

  const user = await getRequestUser(supabase, request.headers);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Cap submissions per user/IP before touching storage or the queue.
  const rateLimited = await enforceUploadRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  let file: File;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (!(candidate instanceof File)) {
      return NextResponse.json(
        { error: 'missing "file" field (multipart/form-data)' },
        { status: 400 },
      );
    }
    file = candidate;
  } catch {
    return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'file is empty' }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit` },
      { status: 413 },
    );
  }
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    return NextResponse.json({ error: 'file must be a PDF' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return NextResponse.json(
      { error: 'file is not a valid PDF (missing %PDF magic bytes)' },
      { status: 400 },
    );
  }

  try {
    await ensureStorageBucket(supabase, STORAGE_BUCKET);
  } catch (err) {
    console.error(
      `[upload] bucket setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: 'storage unavailable' }, { status: 500 });
  }

  // Storage keys are random UUIDs under the user's folder — never derived
  // from the client-provided filename (prevents path traversal/overwrites).
  const storagePath = `${user.id}/${randomUUID()}.pdf`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
  if (uploadError) {
    console.error(`[upload] storage upload failed for user ${user.id}: ${uploadError.message}`);
    return NextResponse.json({ error: 'failed to store file' }, { status: 500 });
  }

  const { data: jobRow, error: insertError } = await supabase
    .from('jobs')
    .insert({ user_id: user.id, status: 'pending', payload_url: storagePath })
    .select('*')
    .single();
  if (insertError || !jobRow) {
    // Roll back the object so we don't orphan files.
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    console.error(
      `[upload] jobs insert failed for user ${user.id}: ${insertError?.message ?? 'unknown'}`,
    );
    return NextResponse.json({ error: 'failed to create job' }, { status: 500 });
  }

  try {
    await enqueueExtraction({
      jobId: jobRow.id,
      userId: user.id,
      bucket: STORAGE_BUCKET,
      storagePath,
      mimeType: 'application/pdf',
      fileName: file.name,
    });
  } catch (err) {
    // The row exists but the queue is unreachable — surface it rather than
    // leaving the job stuck in `pending` forever.
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('jobs')
      .update({ status: 'failed', error: `enqueue failed: ${message}` })
      .eq('id', jobRow.id);
    console.error(`[upload] enqueue failed for job ${jobRow.id}: ${message}`);
    return NextResponse.json({ error: 'failed to enqueue job' }, { status: 503 });
  }

  const body: UploadJobResponse = { job_id: jobRow.id, status: 'pending' };
  return NextResponse.json(body, { status: 202 });
}
