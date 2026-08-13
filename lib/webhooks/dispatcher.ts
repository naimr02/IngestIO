/**
 * Webhook orchestration: signing, payload construction, delivery, and the
 * enqueue step that runs when a job transitions to a terminal state.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getWebhookQueue, JOB_NAMES } from '@ingestio/lib/queue/docQueue';
import { validateWebhookDeliveryData } from '@ingestio/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobRow, WebhookDeliveryData, WebhookEventType } from '@ingestio/shared';

/** Header carrying the HMAC-SHA256 signature of the raw body. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ingestio-signature';
/** Header carrying the webhook event type (e.g. `job.completed`). */
export const WEBHOOK_EVENT_HEADER = 'x-ingestio-event';
/** User-Agent advertised on outbound deliveries. */
export const WEBHOOK_USER_AGENT = 'ingestio-webhook/0.1';

/** HMAC-SHA256 signature of the raw request body using the webhook secret. */
export function signPayload(secretKey: string, body: string): string {
  return createHmac('sha256', secretKey).update(body).digest('hex');
}

/** Constant-time signature check — use on the receiving side to verify. */
export function verifyWebhookSignature(
  secretKey: string,
  body: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPayload(secretKey, body), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** The JSON body sent to `target_url` (also reused as the delivery payload). */
export function buildWebhookPayload(
  eventType: WebhookEventType,
  job: JobRow,
): Record<string, unknown> {
  return {
    event: eventType,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      result: job.result_json,
      error: job.error,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Deliver one webhook. The body is signed with the endpoint's `secret_key`
 * and sent in the `X-IngestIO-Signature` header. Non-2xx responses throw so
 * the delivery queue's own retry/backoff (3 attempts) takes over.
 */
export async function dispatchWebhook(delivery: WebhookDeliveryData): Promise<void> {
  // Fail fast on corrupt queue payloads (a caller can convert the thrown
  // PayloadValidationError into an unrecoverable failure to skip retries).
  const valid = validateWebhookDeliveryData(delivery);

  const body = JSON.stringify(valid.payload);
  const signature = signPayload(valid.secretKey, body);

  const res = await fetch(valid.targetUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': WEBHOOK_USER_AGENT,
      [WEBHOOK_EVENT_HEADER]: valid.eventType,
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`webhook delivery to ${valid.targetUrl} returned ${res.status}`);
  }
}

/**
 * Called when a job reaches a terminal state: loads the user's webhooks that
 * subscribed to `eventType` and enqueues a `webhook.deliver` job per endpoint.
 * Returns the number of deliveries enqueued.
 */
export async function enqueueWebhookDeliveries(
  supabase: SupabaseClient,
  job: JobRow,
  eventType: WebhookEventType,
): Promise<number> {
  const { data: webhooks, error } = await supabase
    .from('webhooks')
    .select('id, target_url, secret_key')
    .eq('user_id', job.user_id)
    .eq('event_type', eventType);

  if (error) {
    console.warn(
      `[webhooks] failed to load webhooks for user ${job.user_id}: ${error.message}`,
    );
    return 0;
  }

  const payload = buildWebhookPayload(eventType, job);
  let enqueued = 0;

  for (const webhook of webhooks ?? []) {
    await getWebhookQueue().add(
      JOB_NAMES.webhookDeliver,
      {
        webhookId: webhook.id,
        jobId: job.id,
        userId: job.user_id,
        targetUrl: webhook.target_url,
        eventType,
        secretKey: webhook.secret_key,
        payload,
      } satisfies WebhookDeliveryData,
    );
    enqueued += 1;
  }

  return enqueued;
}
