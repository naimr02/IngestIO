/**
 * Webhook verification (receiving side): replay protection + signature check.
 *
 * Outgoing deliveries carry:
 *   X-IngestIO-Timestamp   — epoch ms of dispatch (Date.now().toString())
 *   X-IngestIO-Signature   — HMAC-SHA256(secret, `${timestamp}.${body}`)
 *
 * Verifiers must reject payloads whose timestamp is outside a 5-minute window
 * (replay attacks reuse a captured body + signature after the window expires).
 */

import { timingSafeEqual } from 'node:crypto';
import { signPayload } from './dispatcher';

export { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from './dispatcher';

/** Reject deliveries whose timestamp is older (or further ahead) than 5 minutes. */
export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Constant-time verification of a delivery. Returns `false` for missing or
 * malformed timestamps, stale timestamps (outside the freshness window), and
 * any signature that doesn't match `HMAC-SHA256(secret, `${timestamp}.${body}`)`.
 */
export function verifyWebhookSignature(
  secretKey: string,
  body: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > WEBHOOK_MAX_AGE_MS) return false;

  const expected = Buffer.from(signPayload(secretKey, body, timestamp), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
