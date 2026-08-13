import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_USER_AGENT,
  buildWebhookPayload,
  signPayload,
  verifyWebhookSignature,
} from '@ingestio/lib/webhooks/dispatcher';
import { validateWebhookDeliveryData } from '@ingestio/shared';
import type { JobRow, WebhookDeliveryData } from '@ingestio/shared';

describe('HMAC webhook signature generation', () => {
  it('matches a known HMAC-SHA256 vector', () => {
    // Computed independently: HMAC-SHA256("super-secret-key", "hello world")
    expect(signPayload('super-secret-key', 'hello world')).toBe(
      '62702cb79bceeba4d3f64ffd8253c3d44fbe19870d83e099f6498af265c83b61',
    );
  });

  it('matches RFC 4231 test case 1 (20 bytes of 0x0b, "Hi There")', () => {
    expect(signPayload('\u000b'.repeat(20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('is deterministic for identical inputs', () => {
    expect(signPayload('secret', 'body')).toBe(signPayload('secret', 'body'));
  });

  it('changes when the body changes', () => {
    expect(signPayload('secret', 'body-a')).not.toBe(signPayload('secret', 'body-b'));
  });

  it('changes when the secret changes', () => {
    expect(signPayload('secret-a', 'body')).not.toBe(signPayload('secret-b', 'body'));
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 's3cret';
  const body = JSON.stringify({ event: 'job.completed', job: { id: 'abc' } });

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(secret, body, signPayload(secret, body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signPayload(secret, body);
    expect(verifyWebhookSignature(secret, `${body} `, signature)).toBe(false);
  });

  it('rejects a signature created with a different secret', () => {
    expect(verifyWebhookSignature('other-secret', body, signPayload(secret, body))).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it('rejects a signature of a different length (timing-safe path)', () => {
    expect(verifyWebhookSignature(secret, body, 'tooshort')).toBe(false);
  });
});

describe('webhook HTTP headers', () => {
  it('signals the signature in the X-IngestIO-Signature header', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-ingestio-signature');
  });

  it('signals the event type in the X-IngestIO-Event header', () => {
    expect(WEBHOOK_EVENT_HEADER).toBe('x-ingestio-event');
  });

  it('advertises the IngestIO user agent', () => {
    expect(WEBHOOK_USER_AGENT).toBe('ingestio-webhook/0.1');
  });
});

describe('buildWebhookPayload', () => {
  const job: JobRow = {
    id: 'j1',
    user_id: 'u1',
    payload_url: 'u1/invoice.pdf',
    status: 'completed',
    progress: 100,
    result_json: { extracted: true },
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('includes the event, a job snapshot, and a timestamp', () => {
    const payload = buildWebhookPayload('job.completed', job);
    expect(payload.event).toBe('job.completed');
    expect(payload.job).toMatchObject({
      id: 'j1',
      status: 'completed',
      progress: 100,
      result: { extracted: true },
      error: null,
    });
    expect(typeof payload.timestamp).toBe('string');
  });

  it('produces a payload accepted by the delivery validator', () => {
    const delivery: WebhookDeliveryData = {
      webhookId: 'w1',
      jobId: job.id,
      userId: job.user_id,
      targetUrl: 'https://example.com/hook',
      eventType: 'job.completed',
      secretKey: 'sk',
      payload: buildWebhookPayload('job.completed', job),
    };
    expect(() => validateWebhookDeliveryData(delivery)).not.toThrow();
  });
});
