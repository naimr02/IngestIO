/**
 * IngestIO — API rate limiting (Upstash Redis sliding window).
 *
 * Used by the upload route to cap abusive submissions: 5 requests per minute
 * per client. The identifier prefers the authenticated user id and falls back
 * to the client IP (`x-forwarded-for`, first hop).
 *
 * Degradation policy: when Upstash REST env vars are missing the limiter is a
 * no-op (the API stays usable without it), and transient limiter errors fail
 * open with a warning so an Upstash outage doesn't take down uploads.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';

export const UPLOAD_RATE_LIMIT = 5;
export const UPLOAD_RATE_WINDOW_SECONDS = 60;

let limiter: Ratelimit | undefined;
let warned = false;

function getUploadLimiter(): Ratelimit | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warned) {
      console.warn(
        '[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting disabled',
      );
      warned = true;
    }
    return null;
  }
  if (!limiter) {
    limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(UPLOAD_RATE_LIMIT, `${UPLOAD_RATE_WINDOW_SECONDS} s`),
      prefix: 'ingestio:ratelimit',
    });
  }
  return limiter;
}

/** Identifier for one client: authenticated user id, else first IP hop. */
export function getRateLimitIdentifier(request: Request, userId?: string): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0]?.trim() : undefined;
  return `ip:${ip ?? '127.0.0.1'}`;
}

/**
 * Enforce the upload rate limit. Returns a `429` `NextResponse` (with standard
 * rate-limit headers) when the client is over the limit, or `null` to allow
 * the request through.
 */
export async function enforceUploadRateLimit(
  request: Request,
  userId?: string,
): Promise<NextResponse | null> {
  const activeLimiter = getUploadLimiter();
  if (!activeLimiter) return null;

  let result: Awaited<ReturnType<Ratelimit['limit']>>;
  try {
    result = await activeLimiter.limit(getRateLimitIdentifier(request, userId));
  } catch (err) {
    console.warn(
      `[rate-limit] limiter error, allowing request: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (result.success) return null;

  return NextResponse.json(
    { error: 'Rate limit exceeded. Please try again in 1 minute.' },
    {
      status: 429,
      headers: {
        'x-ratelimit-limit': String(result.limit),
        'x-ratelimit-remaining': String(result.remaining),
        'x-ratelimit-reset': String(result.reset),
      },
    },
  );
}
