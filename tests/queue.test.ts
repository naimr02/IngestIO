import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import {
  JOB_NAMES,
  createRedisConnection,
  enqueueExtraction,
} from '@ingestio/lib/queue/docQueue';
import {
  PayloadValidationError,
  UnrecoverableJobError,
  validateExtractJobData,
  validateWebhookDeliveryData,
} from '@ingestio/shared';
import type { ExtractJobData, WebhookDeliveryData } from '@ingestio/shared';

const validExtract: ExtractJobData = {
  jobId: randomUUID(),
  userId: 'u1',
  bucket: 'documents',
  storagePath: 'u1/invoice.pdf',
  mimeType: 'application/pdf',
  fileName: 'invoice.pdf',
};

describe('ExtractJobData payload validation', () => {
  it('accepts a valid payload', () => {
    expect(validateExtractJobData(validExtract)).toEqual(validExtract);
  });

  it('accepts a minimal payload (optional fields omitted)', () => {
    const { mimeType, fileName, ...minimal } = validExtract;
    expect(validateExtractJobData(minimal)).toEqual(minimal);
  });

  it('rejects non-object input', () => {
    expect(() => validateExtractJobData(null)).toThrow(PayloadValidationError);
    expect(() => validateExtractJobData('nope')).toThrow(PayloadValidationError);
    expect(() => validateExtractJobData([validExtract])).toThrow(PayloadValidationError);
  });

  it.each([
    ['empty jobId', { ...validExtract, jobId: '' }],
    ['missing userId', { ...validExtract, userId: undefined }],
    ['non-string bucket', { ...validExtract, bucket: 42 }],
    ['blank storagePath', { ...validExtract, storagePath: '   ' }],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateExtractJobData(payload)).toThrow(PayloadValidationError);
  });
});

describe('WebhookDeliveryData payload validation', () => {
  const valid: WebhookDeliveryData = {
    webhookId: 'w1',
    jobId: 'j1',
    userId: 'u1',
    targetUrl: 'https://example.com/hook',
    eventType: 'job.completed',
    secretKey: 'sk',
    payload: { event: 'job.completed', job: { id: 'j1' } },
  };

  it('accepts a valid payload', () => {
    expect(validateWebhookDeliveryData(valid)).toEqual(valid);
  });

  it('rejects an unknown eventType', () => {
    expect(() =>
      validateWebhookDeliveryData({ ...valid, eventType: 'job.updated' }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects a non-http(s) targetUrl', () => {
    expect(() => validateWebhookDeliveryData({ ...valid, targetUrl: 'ftp://h/x' })).toThrow(
      PayloadValidationError,
    );
    expect(() => validateWebhookDeliveryData({ ...valid, targetUrl: 'not-a-url' })).toThrow(
      PayloadValidationError,
    );
  });

  it('rejects a missing secretKey', () => {
    expect(() => validateWebhookDeliveryData({ ...valid, secretKey: '' })).toThrow(
      PayloadValidationError,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => validateWebhookDeliveryData({ ...valid, payload: 'raw' })).toThrow(
      PayloadValidationError,
    );
  });
});

describe('enqueueExtraction guard', () => {
  it('rejects an invalid payload before touching Redis', async () => {
    await expect(
      enqueueExtraction({ userId: 'u1' } as unknown as ExtractJobData),
    ).rejects.toThrow(PayloadValidationError);
  });
});

describe('unrecoverable error contract', () => {
  it('uses BullMQ’s name sentinel so corrupt payloads fail without retries', () => {
    const err = new UnrecoverableJobError('corrupt payload');
    expect(err.name).toBe('UnrecoverableError');
    expect(err.message).toBe('corrupt payload');
  });
});

/**
 * Live BullMQ round-trip against a real Redis. Skipped unless TEST_REDIS_URL
 * is set (e.g. `TEST_REDIS_URL=rediss://... npm test` with a local or Upstash
 * Redis instance).
 */
describe.skipIf(!process.env.TEST_REDIS_URL)('live BullMQ round-trip', () => {
  it('adds a doc.extract job and reads it back with a valid payload', async () => {
    const queue = new Queue<ExtractJobData>(`ingestio.test.${randomUUID()}`, {
      connection: createRedisConnection(false, process.env.TEST_REDIS_URL),
      defaultJobOptions: { attempts: 1 },
    });

    try {
      const id = `ingestio:${validExtract.jobId}`;
      await queue.add(JOB_NAMES.extract, validExtract, { jobId: id });

      const job = await queue.getJob(id);
      expect(job?.name).toBe(JOB_NAMES.extract);
      expect(job?.data).toEqual(validExtract);
      expect(validateExtractJobData(job?.data)).toEqual(validExtract);
    } finally {
      await queue.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
    }
  });
});
