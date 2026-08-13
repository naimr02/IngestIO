/**
 * IngestIO — worker bootstrap.
 *
 * Boots two BullMQ workers:
 *   • `ingestio.docs`      — extraction pipeline (see workers/docWorker.ts)
 *   • `ingestio.webhooks`  — webhook delivery (see lib/webhooks/dispatcher.ts)
 *
 * Shared `failed` listener: marks extraction jobs failed in Postgres and moves
 * payloads that exhausted all attempts to the dead-letter queue.
 *
 * Run: npm run dev:worker (tsx) | npm run build && npm start (tsup → node)
 */

import 'dotenv/config';

import { Worker } from 'bullmq';
import {
  JOB_NAMES,
  QUEUES,
  backoffStrategy,
  createRedisConnection,
  getDeadLetterQueue,
} from '@ingestio/lib/queue/docQueue';
import { getSupabaseAdmin } from '@ingestio/lib/supabase/admin';
import { dispatchWebhook } from '@ingestio/lib/webhooks/dispatcher';
import { createDocWorker } from '@ingestio/workers/docWorker';
import { PayloadValidationError, UnrecoverableJobError } from '@ingestio/shared';
import type { DeadLetterEntry, ExtractJobData, WebhookDeliveryData } from '@ingestio/shared';

const supabase = getSupabaseAdmin();

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);

interface FailedJobLike {
  name: string;
  data: ExtractJobData | WebhookDeliveryData;
  attemptsMade: number;
  opts: { attempts?: number };
}

/**
 * Shared `failed` listener for both workers.
 *
 * BullMQ emits `failed` after EVERY failed attempt, so only act when the last
 * attempt is exhausted: update the `jobs` row, then move the payload to the
 * dead-letter queue for inspection/replay.
 */
async function handleFailed(job: FailedJobLike | undefined, error: Error): Promise<void> {
  if (!job) return;

  const maxAttempts = job.opts.attempts ?? 1;
  // Unrecoverable errors (e.g. corrupt payloads) fail the job immediately,
  // even though attemptsMade is below the limit — treat them as final.
  const isFinalAttempt =
    error.name === 'UnrecoverableError' || job.attemptsMade >= maxAttempts;

  if (job.name === JOB_NAMES.extract) {
    // Extraction failure → the job itself failed. Webhook delivery failures
    // must NOT flip an already-completed job back to `failed`.
    await supabase
      .from('jobs')
      .update({ status: 'failed', error: error.message })
      .eq('id', job.data.jobId);
  }

  if (!isFinalAttempt) {
    console.warn(
      `[${job.name}] attempt ${job.attemptsMade}/${maxAttempts} failed, retrying with backoff: ${error.message}`,
    );
    return;
  }

  const entry: DeadLetterEntry = {
    originalQueue: job.name === JOB_NAMES.extract ? QUEUES.docs : QUEUES.webhooks,
    jobName: job.name,
    data: job.data,
    error: error.message,
    attemptsMade: job.attemptsMade,
    failedAt: new Date().toISOString(),
  };
  await getDeadLetterQueue().add('dlq', entry);
  console.error(
    `[${job.name}] exhausted ${maxAttempts} attempts → moved to DLQ: ${error.message}`,
  );
}

async function main(): Promise<void> {
  const docWorker = createDocWorker(supabase, { concurrency: CONCURRENCY });

  const webhookWorker = new Worker<WebhookDeliveryData>(
    QUEUES.webhooks,
    async (job) => {
      try {
        await dispatchWebhook(job.data);
      } catch (err) {
        // A malformed delivery payload can't be fixed by retrying.
        if (err instanceof PayloadValidationError) {
          throw new UnrecoverableJobError(err.message);
        }
        throw err;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: CONCURRENCY,
      settings: { backoffStrategy },
    },
  );

  docWorker.on('failed', handleFailed);
  webhookWorker.on('failed', handleFailed);

  docWorker.on('completed', (job) => console.log(`[${job.name}] completed (${job.id})`));
  webhookWorker.on('completed', (job) => console.log(`[${job.name}] completed (${job.id})`));

  docWorker.on('error', (err) => console.error('doc worker error:', err.message));
  webhookWorker.on('error', (err) => console.error('webhook worker error:', err.message));

  console.log(
    `IngestIO worker listening on: ${QUEUES.docs}, ${QUEUES.webhooks} (concurrency ${CONCURRENCY})`,
  );

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down…');
    await Promise.all([docWorker.close(), webhookWorker.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
