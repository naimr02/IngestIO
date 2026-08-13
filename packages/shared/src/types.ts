/**
 * Shared domain + queue types for IngestIO.
 *
 * NOTE: once the Supabase CLI is wired up, prefer `supabase gen types typescript`
 * for row types and map from the generated `Database` type — keep this file as
 * the single source of truth for queue payloads.
 */

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = ['job.completed', 'job.failed'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Row shape of `public.jobs`. */
export interface JobRow {
  id: string;
  user_id: string;
  /** Object path of the uploaded document inside the storage bucket. */
  payload_url: string;
  status: JobStatus;
  /** Worker-reported progress, 0–100. */
  progress: number;
  /** Normalized extraction output. */
  result_json: Record<string, unknown> | null;
  /** Last failure message (drives DLQ routing + webhooks). */
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape of `public.webhooks`. */
export interface WebhookRow {
  id: string;
  user_id: string;
  target_url: string;
  /** HMAC signing secret (never returned to the browser). */
  secret_key: string;
  event_type: WebhookEventType;
  created_at: string;
  updated_at: string;
}

/** Payload for a `doc.extract` job on the primary queue. */
export interface ExtractJobData {
  /** PK of the `jobs` row (used as the BullMQ jobId for idempotency). */
  jobId: string;
  userId: string;
  /** Supabase Storage bucket containing the source document. */
  bucket: string;
  /** Object path within the bucket (mirrored in `jobs.payload_url`). */
  storagePath: string;
  mimeType?: string;
  fileName?: string;
}

/** Payload for a `webhook.deliver` job. */
export interface WebhookDeliveryData {
  webhookId: string;
  jobId: string;
  userId: string;
  targetUrl: string;
  eventType: WebhookEventType;
  /** Used to sign the payload (HMAC-SHA256). */
  secretKey: string;
  payload: Record<string, unknown>;
}

/** Shape of a dead-letter entry: original job plus failure metadata. */
export interface DeadLetterEntry {
  originalQueue: string;
  jobName: string;
  data: ExtractJobData | WebhookDeliveryData;
  error: string;
  attemptsMade: number;
  failedAt: string;
}

/** Response of `POST /api/jobs/upload` (HTTP 202). */
export interface UploadJobResponse {
  job_id: string;
  status: JobStatus;
}

/** Response of `GET /api/jobs/[id]`. */
export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  progress: number;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
