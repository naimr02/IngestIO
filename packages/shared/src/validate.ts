/**
 * Runtime validation for data crossing the queue boundary.
 *
 * BullMQ payloads are plain JSON — nothing stops a corrupt or hand-crafted
 * payload from being processed. Validators here fail fast (before enqueue,
 * before extraction, before dispatch) and pair with `UnrecoverableJobError`
 * so a bad payload fails the job immediately instead of burning retries.
 */

import { WEBHOOK_EVENT_TYPES } from './types';
import type { ExtractJobData, WebhookDeliveryData, WebhookEventType } from './types';

/** Thrown by every validator when the payload is malformed. */
export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadValidationError';
  }
}

/**
 * Error whose `name` matches BullMQ's unrecoverable sentinel: when a processor
 * throws it, BullMQ moves the job straight to `failed` without retries — the
 * right behaviour for a payload that can never succeed.
 */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

function assertObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PayloadValidationError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PayloadValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return assertNonEmptyString(value, field);
}

function assertHttpUrl(value: unknown, field: string): string {
  const url = assertNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PayloadValidationError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PayloadValidationError(`${field} must use http(s)`);
  }
  return url;
}

export function validateWebhookEventType(value: unknown): WebhookEventType {
  if (typeof value !== 'string' || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new PayloadValidationError(
      `eventType must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}`,
    );
  }
  return value as WebhookEventType;
}

/** Validate a `doc.extract` payload; returns the normalized value or throws. */
export function validateExtractJobData(input: unknown): ExtractJobData {
  const data = assertObject(input, 'extract job payload');
  return {
    jobId: assertNonEmptyString(data.jobId, 'jobId'),
    userId: assertNonEmptyString(data.userId, 'userId'),
    bucket: assertNonEmptyString(data.bucket, 'bucket'),
    storagePath: assertNonEmptyString(data.storagePath, 'storagePath'),
    mimeType: assertOptionalString(data.mimeType, 'mimeType'),
    fileName: assertOptionalString(data.fileName, 'fileName'),
  };
}

/** Validate a `webhook.deliver` payload; returns the normalized value or throws. */
export function validateWebhookDeliveryData(input: unknown): WebhookDeliveryData {
  const data = assertObject(input, 'webhook delivery payload');
  return {
    webhookId: assertNonEmptyString(data.webhookId, 'webhookId'),
    jobId: assertNonEmptyString(data.jobId, 'jobId'),
    userId: assertNonEmptyString(data.userId, 'userId'),
    targetUrl: assertHttpUrl(data.targetUrl, 'targetUrl'),
    eventType: validateWebhookEventType(data.eventType),
    secretKey: assertNonEmptyString(data.secretKey, 'secretKey'),
    payload: assertObject(data.payload, 'payload'),
  };
}
