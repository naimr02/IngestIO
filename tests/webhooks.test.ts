import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_USER_AGENT,
  buildWebhookPayload,
  signPayload,
} from '@ingestio/lib/webhooks/dispatcher';
import { WEBHOOK_MAX_AGE_MS, verifyWebhookSignature } from '@ingestio/lib/webhooks/verifier';
import { validateWebhookDeliveryData } from '@ingestio/shared';
import type { JobRow, WebhookDeliveryData } from '@ingestio/shared';

// Fixed dispatch timestamp keeps the known-answer vectors stable.
const TS = '1712345678901';

describe('HMAC webhook signature generation', () => {
  it('matches a known HMAC-SHA256 vector over `timestamp.body`', () => {
    // Computed independently: HMAC-SHA256("super-secret-key", "1712345678901.hello world")
    expect(signPayload('super-secret-key', 'hello world', TS)).toBe(
      '20898ddfb8a7a1a670ffc6e75fbf0dcbfc558c455d50915e3e98edadb22b6f1d',
    );
  });

  it('matches RFC 4231 test case 1 key material (0x0b × 20, "Hi There")', () => {
    // Computed independently: HMAC-SHA256(0x0b×20, "1700000000000.Hi There")
    expect(signPayload('\u000b'.repeat(20), 'Hi There', '1700000000000')).toBe(
      '2c7c5dba72c47511e5c4e94ae508f215afc4645e7b05714d153aa5b3727b3164',
    );
  });

  it('is deterministic for identical inputs', () => {
    expect(signPayload('secret', 'body', TS)).toBe(signPayload('secret', 'body', TS));
  });

  it('changes when the body changes', () => {
    expect(signPayload('secret', 'body-a', TS)).not.toBe(signPayload('secret', 'body-b', TS));
  });

  it('changes when the secret changes', () => {
    expect(signPayload('secret-a', 'body', TS)).not.toBe(signPayload('secret-b', 'body', TS));
  });

  it('changes when the timestamp changes (replay binding)', () => {
    expect(signPayload('secret', 'body', TS)).not.toBe(
      signPayload('secret', 'body', '1712345678902'),
    );
  });
});

describe('verifyWebhookSignature (replay protection)', () => {
  const secret = 's3cret';
  const body = JSON.stringify({ event: 'job.completed', job: { id: 'abc' } });
  const now = Date.now().toString();

  it('accepts a fresh valid signature', () => {
    expect(verifyWebhookSignature(secret, body, signPayload(secret, body, now), now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signPayload(secret, body, now);
    expect(verifyWebhookSignature(secret, `${body} `, signature, now)).toBe(false);
  });

  it('rejects a signature created with a different secret', () => {
    expect(
      verifyWebhookSignature('other-secret', body, signPayload(secret, body, now), now),
    ).toBe(false);
  });

  it('rejects a signature bound to a different timestamp', () => {
    expect(
      verifyWebhookSignature(secret, body, signPayload(secret, body, '1700000000000'), now),
    ).toBe(false);
  });

  it('rejects a stale timestamp (replay) — older than the 5-minute window', () => {
    const stale = (Date.now() - WEBHOOK_MAX_AGE_MS - 1_000).toString();
    const signature = signPayload(secret, body, stale);
    expect(verifyWebhookSignature(secret, body, signature, stale)).toBe(false);
  });

  it('rejects a timestamp from the future', () => {
    const future = (Date.now() + WEBHOOK_MAX_AGE_MS + 1_000).toString();
    const signature = signPayload(secret, body, future);
    expect(verifyWebhookSignature(secret, body, signature, future)).toBe(false);
  });

  it('accepts a timestamp inside the freshness window', () => {
    const inside = (Date.now() - WEBHOOK_MAX_AGE_MS + 5_000).toString();
    const signature = signPayload(secret, body, inside);
    expect(verifyWebhookSignature(secret, body, signature, inside)).toBe(true);
  });

  it('rejects a missing signature or timestamp', () => {
    expect(verifyWebhookSignature(secret, body, null, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, signPayload(secret, body, now), null)).toBe(false);
  });

  it('rejects a malformed timestamp', () => {
    const signature = signPayload(secret, body, 'not-a-number');
    expect(verifyWebhookSignature(secret, body, signature, 'not-a-number')).toBe(false);
  });

  it('rejects a signature of a different length (timing-safe path)', () => {
    expect(verifyWebhookSignature(secret, body, 'tooshort', now)).toBe(false);
  });
});

describe('webhook HTTP headers', () => {
  it('signals the signature in the X-IngestIO-Signature header', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-ingestio-signature');
  });

  it('signals the event type in the X-IngestIO-Event header', () => {
    expect(WEBHOOK_EVENT_HEADER).toBe('x-ingestio-event');
  });

  it('signals the dispatch timestamp in the X-IngestIO-Timestamp header', () => {
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('x-ingestio-timestamp');
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
