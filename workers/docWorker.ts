/**
 * IngestIO — extraction worker (`ingestio.docs`).
 *
 * Lifecycle for one job:
 *   processing (0%) → download PDF from Supabase Storage via fresh signed URL
 *   → 25% → Gemini structured extraction → 50% → persist result_json (100%)
 *   → enqueue webhook deliveries for `job.completed`.
 *
 * Failures re-throw so BullMQ applies the exponential backoff strategy
 * (`backoffStrategy` in lib/queue/docQueue.ts); the process-level `failed`
 * listener handles the final-attempt bookkeeping and DLQ routing.
 */

import { Worker, type Job } from 'bullmq';
import { QUEUES, backoffStrategy, createRedisConnection } from '@ingestio/lib/queue/docQueue';
import { getSupabaseAdmin } from '@ingestio/lib/supabase/admin';
import { sanitizeMessage } from '@ingestio/lib/sanitize';
import { extractStructuredJsonFromPdf } from '@ingestio/lib/gemini/client';
import { enqueueWebhookDeliveries } from '@ingestio/lib/webhooks/dispatcher';
import { UnrecoverableJobError, validateExtractJobData } from '@ingestio/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractJobData } from '@ingestio/shared';

/** Gemini inline_data ceiling (free tier). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

// Route stdout through the sanitizer so tokens/keys never reach log drains.
const log = (msg: unknown) => console.log(sanitizeMessage(msg));
const warn = (msg: unknown) => console.warn(sanitizeMessage(msg));

export interface DocWorkerOptions {
  concurrency?: number;
}

/** Instantiate the extraction worker. Pass a client for testability. */
export function createDocWorker(
  supabase?: SupabaseClient,
  options: DocWorkerOptions = {},
): Worker<ExtractJobData> {
  const client = supabase ?? getSupabaseAdmin();

  return new Worker<ExtractJobData>(
    QUEUES.docs,
    (job) => processDocJob(job, client),
    {
      connection: createRedisConnection(),
      concurrency: options.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4),
      settings: { backoffStrategy },
    },
  );
}

/** Core processor: download → extract → persist → notify. */
export async function processDocJob(
  job: Job<ExtractJobData>,
  supabase: SupabaseClient,
): Promise<{ ok: true }> {
  // A corrupt payload will never succeed — fail immediately, skip retries.
  let data: ExtractJobData;
  try {
    data = validateExtractJobData(job.data);
  } catch (err) {
    throw new UnrecoverableJobError(err instanceof Error ? err.message : String(err));
  }
  const { jobId, userId, bucket, storagePath, mimeType, fileName } = data;

  await setJobState(supabase, jobId, { status: 'processing', progress: 0 });

  const pdf = await downloadPdf(supabase, bucket, storagePath);
  await reportProgress(job, supabase, jobId, 25);

  const result = await extractStructuredJsonFromPdf({ pdf, mimeType, fileName });
  await reportProgress(job, supabase, jobId, 50);

  await supabase
    .from('jobs')
    .update({ status: 'completed', progress: 100, result_json: result })
    .eq('id', jobId);
  await reportProgress(job, supabase, jobId, 100);

  // Notify the user's webhooks that the job completed.
  const { data: jobRow } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (jobRow) {
    const enqueued = await enqueueWebhookDeliveries(supabase, jobRow, 'job.completed');
    if (enqueued > 0) {
      log(`[doc.extract] enqueued ${enqueued} webhook delivery(ies) for job ${jobId}`);
    }
  }

  log(`[doc.extract] job ${jobId} (user ${userId}) completed`);
  return { ok: true };
}

/** Download the PDF using a short-lived signed URL generated on demand. */
async function downloadPdf(
  supabase: SupabaseClient,
  bucket: string,
  storagePath: string,
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 60);
  if (error || !data) {
    throw new Error(
      `failed to create signed URL for ${bucket}/${storagePath}: ${error?.message ?? 'unknown error'}`,
    );
  }

  const res = await fetch(data.signedUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`PDF download from ${bucket}/${storagePath} returned ${res.status}`);
  }

  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.byteLength === 0) {
    throw new Error(`PDF at ${bucket}/${storagePath} is empty`);
  }
  if (pdf.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is ${(pdf.byteLength / 1024 / 1024).toFixed(1)} MB — over the ${MAX_PDF_BYTES / 1024 / 1024} MB limit`,
    );
  }
  return pdf;
}

/** Progress lives in two places: Redis (BullMQ job) and Postgres (jobs row). */
async function reportProgress(
  job: Job<ExtractJobData>,
  supabase: SupabaseClient,
  jobId: string,
  progress: number,
): Promise<void> {
  await setJobState(supabase, jobId, { progress });
  try {
    await job.updateProgress(progress); // writes to Redis
  } catch (err) {
    warn(
      `[doc.extract] failed to report Redis progress for job ${jobId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function setJobState(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('jobs').update(patch).eq('id', jobId);
  if (error) {
    warn(`[doc.extract] failed to update job ${jobId}: ${error.message}`);
  }
}
