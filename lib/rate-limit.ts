/**
 * IngestIO — API rate limiting with in-memory fallback.
 *
 * Used by the upload route to cap abusive submissions: 5 requests per minute
 * per client. The identifier prefers the authenticated user id and falls back
 * to the client IP (x-forwarded-for, first hop).
 *
 * Priority: Upstash Redis (distributed) > in-memory Map (single-instance).
 * Both use sliding window. In-memory is zero-config but doesn't share state
 * across instances — acceptable for dev/single-container deploys.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';

export const UPLOAD_RATE_LIMIT = 5;
export const UPLOAD_RATE_WINDOW_SECONDS = 60;

// In-memory sliding window fallback
const memoryStore = new Map<string, number[]>();
let memoryCleanupCounter = 0;
const MEMORY_CLEANUP_INTERVAL = 100; // run cleanup every N calls

function memoryLimit(key: string): { success: boolean; limit: number; remaining: number; reset: number } {
  const now = Date.now();
  const windowMs = UPLOAD_RATE_WINDOW_SECONDS * 1000;
  const windowStart = now - windowMs;

  const timestamps = memoryStore.get(key) ?? [];
  // Drop expired entries
  const valid = timestamps.filter(ts => ts > windowStart);
  valid.push(now);
  memoryStore.set(key, valid);

  // Periodic cleanup of stale keys (shortcut: probabilistic, not guaranteed; acceptable for dev/single-instance)
  if (++memoryCleanupCounter >= MEMORY_CLEANUP_INTERVAL) {
    memoryCleanupCounter = 0;
    for (const [k, v] of memoryStore) if (v.every(ts => ts <= windowStart)) memoryStore.delete(k);
  }

  const limit = UPLOAD_RATE_LIMIT;
  const remaining = Math.max(0, limit - valid.length);
  const reset = Math.ceil((valid[0] + windowMs) / 1000); // epoch seconds

  return { success: valid.length <= limit, limit, remaining, reset };
}

let redisLimiter: Ratelimit | undefined;
let redisWarned = false;

function getRedisLimiter(): Ratelimit | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!redisWarned) {
      console.warn('[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — using in-memory fallback');
      redisWarned = true;
    }
    return null;
  }
  if (!redisLimiter) {
    redisLimiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(UPLOAD_RATE_LIMIT, `${UPLOAD_RATE_WINDOW_SECONDS} s`),
      prefix: 'ingestio:ratelimit',
    });
  }
  return redisLimiter;
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
export { memoryStore }; // for tests

export async function enforceUploadRateLimit(
  request: Request,
  userId?: string,
): Promise<NextResponse | null> {
  const redis = getRedisLimiter();
  const key = getRateLimitIdentifier(request, userId);

  let result: { success: boolean; limit: number; remaining: number; reset: number };
  if (redis) {
    try {
      const r = await redis.limit(key);
      result = { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset };
    } catch (err) {
      console.warn(
        `[rate-limit] Redis limiter error, falling back to memory: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      result = memoryLimit(key);
    }
  } else {
    result = memoryLimit(key);
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
