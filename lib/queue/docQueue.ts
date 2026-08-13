/**
 * IngestIO — BullMQ queue configuration.
 *
 * Pipeline:
 *
 *   web (Next.js) ──enqueue──▶ ingestio.docs ──▶ worker ──▶ Gemini
 *                                                         ├─▶ ingestio.webhooks ──▶ POST target_url
 *                                                         └─(attempts exhausted)─▶ ingestio.docs.dlq
 *
 * Retry strategy (exponential backoff, max 3 attempts):
 *   generic failures → 2s, 4s, 8s
 *   rate-limited (429) → 60s, 120s, 240s
 *   After the final attempt the worker's `failed` listener moves the payload to
 *   the dead-letter queue and marks the `jobs` row as `failed`.
 *
 * All queues run on Upstash Redis; the free tier (256 MB) is why completed/failed
 * job history is capped via `removeOnComplete` / `removeOnFail`.
 */

import { Queue, type BackoffStrategy, type BackoffOptions, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { isRateLimited } from '@ingestio/lib/gemini/client';
import { validateExtractJobData } from '@ingestio/shared';
import type { ExtractJobData, WebhookDeliveryData } from '@ingestio/shared';

/** Redis keys / queue names — treat as an operational contract. */
export const QUEUES = {
  /** Primary extraction queue (web app enqueues, worker consumes). */
  docs: 'ingestio.docs',
  /** Dead-letter queue: jobs that exhausted all retry attempts. */
  docsDlq: 'ingestio.docs.dlq',
  /** Webhook delivery queue (fire-and-forget notifications). */
  webhooks: 'ingestio.webhooks',
} as const;

/** Stable job names — treat as an API contract. */
export const JOB_NAMES = {
  extract: 'doc.extract',
  webhookDeliver: 'webhook.deliver',
} as const;

/** Base delay (ms) for generic transient failures: 2s → 4s → 8s. */
export const RETRY_BASE_DELAY_MS = 2_000;
/** Base delay (ms) for rate-limited (429) failures: 60s → 120s → 240s. */
export const RATE_LIMIT_BASE_DELAY_MS = 60_000;

/**
 * Custom backoff strategy. BullMQ's built-in strategies can't inspect the
 * error, so `custom` + this function is how we give 429s a much longer wait.
 * Must be passed as `WorkerOptions.settings.backoffStrategy`.
 */
export const backoffStrategy: BackoffStrategy = (attemptsMade, _type, err) => {
  const base = isRateLimited(err) ? RATE_LIMIT_BASE_DELAY_MS : RETRY_BASE_DELAY_MS;
  return base * 2 ** Math.max(0, attemptsMade - 1);
};

/** Job-level marker that routes retry delays through `backoffStrategy`. */
const CUSTOM_BACKOFF: BackoffOptions = { type: 'custom' };

/**
 * Defaults applied to every job on the primary queue.
 * 3 attempts = 1 initial run + 2 retries; generic failures give up after ~14s,
 * rate-limited jobs after ~7 minutes.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: CUSTOM_BACKOFF,
  removeOnComplete: { age: 24 * 60 * 60, count: 500 }, // keep 24h / last 500 completed
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 }, // keep 7d / last 1000 failed
};

/** Exponential backoff for queues that use built-in strategies (webhooks). */
const EXPONENTIAL_BACKOFF: BackoffOptions = {
  type: 'exponential',
  delay: 2_000,
};

/**
 * ioredis connection for Upstash Redis.
 *
 * BullMQ requires `maxRetriesPerRequest: null` (it owns its own retry logic) —
 * without it BullMQ throws "connection is not ready". The `rediss://` scheme
 * enables TLS; pass `tls: {}` here instead if you only have a `redis://` URL.
 *
 * Each Queue/Worker must get its own connection (BullMQ uses blocking commands),
 * so call this per instance rather than sharing a singleton.
 */
export function createRedisConnection(enableOfflineQueue = false, url?: string): IORedis {
  const redisUrl = url ?? process.env.UPSTASH_REDIS_URL;
  if (!redisUrl) {
    throw new Error('UPSTASH_REDIS_URL is not set — see .env.example');
  }
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue,
  });
}

// Queue instances hold a connection — keep them as module-level singletons.

let docQueue: Queue<ExtractJobData> | undefined;

/** Primary extraction queue (web app enqueues, worker consumes). */
export function getDocQueue(): Queue<ExtractJobData> {
  if (!docQueue) {
    docQueue = new Queue<ExtractJobData>(QUEUES.docs, {
      connection: createRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return docQueue;
}

let dlqQueue: Queue | undefined;

/** Dead-letter queue. Additions happen from the worker's `failed` listener. */
export function getDeadLetterQueue(): Queue {
  if (!dlqQueue) {
    dlqQueue = new Queue(QUEUES.docsDlq, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 1, // DLQ entries are for inspection/replay, not auto-retry
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return dlqQueue;
}

let webhookQueue: Queue<WebhookDeliveryData> | undefined;

/** Webhook delivery queue, enqueued on job completion/failure. */
export function getWebhookQueue(): Queue<WebhookDeliveryData> {
  if (!webhookQueue) {
    webhookQueue = new Queue<WebhookDeliveryData>(QUEUES.webhooks, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: EXPONENTIAL_BACKOFF,
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return webhookQueue;
}

/**
 * Convenience enqueue helper. The BullMQ jobId is derived from the `jobs` row
 * PK, so re-submitting the same document is idempotent (BullMQ ignores a jobId
 * that already exists) and the worker can look the row up deterministically.
 *
 * The payload is validated before the queue is even touched, so a malformed
 * payload fails fast instead of reaching a worker.
 *
 * NOTE: the prefix uses a hyphen, not a colon — colons are reserved Redis key
 * delimiters and BullMQ rejects custom jobIds containing them (HTTP 503).
 */
export async function enqueueExtraction(data: ExtractJobData): Promise<void> {
  const valid = validateExtractJobData(data);
  await getDocQueue().add(JOB_NAMES.extract, valid, {
    jobId: `ingestio-${valid.jobId}`,
  });
}
