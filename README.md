# IngestIO

**Open-source background document operations platform.** Upload a PDF, get back a
structured JSON extraction — without blocking the request. Multi-tenant uploads
land in Supabase Storage, AI extraction runs on BullMQ workers backed by Upstash
Redis, job metadata lives in Supabase Postgres, and webhooks notify external
services the moment a job completes.

The entire stack runs on **free tiers** (no credit card required): Supabase
(Postgres + Auth + Storage), Upstash (serverless Redis), and the Google Gemini API.

---

## Table of Contents

- [System Architecture](#system-architecture)
- [Why This Project?](#why-this-project)
- [Features](#features)
- [Repository Layout](#repository-layout)
- [API](#api)
- [Worker Pipeline](#worker-pipeline)
- [Queue Pipeline](#queue-pipeline)
- [Webhooks](#webhooks)
- [Database](#database)
- [Setup Guide](#setup-guide)
- [Getting Started](#getting-started)
- [Testing](#testing)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

---

## System Architecture

```mermaid
flowchart LR
    subgraph Client
        Web["Web Client / Dashboard"]
        Hook["External Webhook Endpoint"]
    end

    subgraph Next["Next.js App (Node runtime)"]
        Upload["POST /api/jobs/upload"]
        Status["GET /api/jobs/:id"]
    end

    subgraph Redis["Upstash Redis (BullMQ)"]
        DocsQueue["ingestio.docs"]
        WebhookQueue["ingestio.webhooks"]
        DLQ["ingestio.docs.dlq"]
    end

    subgraph Worker["Node.js Worker (tsx / tsup)"]
        Extractor["doc.extract processor"]
        Deliverer["webhook.deliver processor"]
    end

    subgraph AI["Google AI Studio"]
        Gemini["gemini-3.6-flash"]
    end

    subgraph Supabase["Supabase"]
        PG[("Postgres<br/>jobs · webhooks")]
        Storage[("Storage<br/>PDF objects")]
        Auth["Auth (JWT)"]
    end

    Web -->|"multipart PDF + Bearer token"| Upload
    Upload -->|"insert row (pending)"| PG
    Upload -->|"store object"| Storage
    Upload -->|"enqueue doc.extract"| DocsQueue
    Status -->|"live status / progress / result"| PG
    Auth -.->|"verify token"| Upload
    Auth -.->|"verify token"| Status

    DocsQueue -->|"consume"| Extractor
    Extractor -->|"fresh signed URL"| Storage
    Extractor -->|"PDF"| Gemini
    Gemini -->|"structured JSON"| Extractor
    Extractor -->|"progress 25/50/100 · result_json"| PG
    Extractor -->|"enqueue webhook.deliver"| WebhookQueue
    Extractor -.->|"attempts exhausted"| DLQ

    WebhookQueue -->|"consume"| Deliverer
    Deliverer -->|"HMAC-SHA256 signed POST"| Hook
    Deliverer -.->|"attempts exhausted"| DLQ
```

## Why This Project?

**Async background execution.** PDF ingestion and LLM extraction are slow and
bursty — they don't belong on a request/response path. `POST /api/jobs/upload`
returns `202 Accepted` with a `job_id` in milliseconds; the heavy work (download,
Gemini inference, normalization) happens off-request in a worker that scales
horizontally by simply adding more instances. `GET /api/jobs/:id` gives real-time
visibility into progress (25% → 50% → 100%), status, and the final result — with
progress mirrored to both Redis and Postgres so it survives restarts.

**Rate-limit resilience.** LLM APIs throttle aggressively, and a naive retry loop
makes it worse. Every failure is classified: **429s back off 60s → 120s → 240s**,
generic transient errors 2s → 4s → 8s, max 3 attempts, and jobs that exhaust
their budget land in a dead-letter queue with full error metadata for inspection
and replay. Corrupt queue payloads fail immediately (`UnrecoverableError`)
instead of burning retries. No job is ever silently lost.

**Zero-cost hosting.** Every dependency has a generous free tier: Supabase
(Postgres, Auth, Storage — 500 MB database, 1 GB storage), Upstash (256 MB Redis,
10k commands/day), and Gemini (free daily quota, including `gemini-3.6-flash`).
Deploy the Next.js app on Vercel's Hobby plan and run the worker as a single
container on any free-tier host (Railway, Render, Fly.io) — a fully functional
production topology for $0/month.

## Features

- **Multi-tenant by design** — every table is RLS-protected; API routes scope all
  queries to the verified `user.id`.
- **202-async upload API** — validates PDF magic bytes, caps file size (20 MB),
  rolls back storage on failure, never leaves a job stuck in `pending`.
- **Structured extraction** — `gemini-3.6-flash` (configurable via `GEMINI_MODEL`) with `responseMimeType: json`
  and a strict-JSON prompt; tolerant of markdown-fenced model output.
- **429-aware exponential backoff** — custom BullMQ `backoffStrategy` inspects the
  error class (3 attempts max).
- **Dead-letter queue** — exhausted jobs move to `ingestio.docs.dlq` with
  `error`, `attemptsMade`, and `failedAt` for replay tooling.
- **Signed webhooks** — HMAC-SHA256 signatures in `X-IngestIO-Signature`, with a
  constant-time verifier for the receiving side.
- **Idempotent enqueues** — BullMQ `jobId = ingestio-<row-id>` makes re-submissions
  no-ops.
- **Runtime payload validation** — queue payloads are validated before enqueue
  and before processing; malformed payloads fail fast.

## Repository Layout

```
.
├── apps/
│   ├── web/                  Next.js App Router — API routes + UI
│   │   └── app/api/jobs/
│   │       ├── upload/route.ts     POST: store PDF → insert job → enqueue → 202
│   │       └── [id]/route.ts       GET: live status + progress
│   └── worker/               Worker bootstrap (doc + webhook workers, DLQ listener)
├── packages/
│   └── shared/               Shared domain + queue types + runtime payload validators
├── workers/
│   └── docWorker.ts          Extraction worker: download → Gemini → persist → notify
├── lib/
│   ├── queue/docQueue.ts     BullMQ queues, 429-aware backoff strategy, DLQ
│   ├── gemini/client.ts      Gemini REST client (structured JSON extraction)
│   ├── webhooks/dispatcher.ts HMAC signing + payload building + delivery + enqueue
│   ├── supabase/admin.ts     Service-role client + storage bucket helper
│   └── api/auth.ts           Bearer-token auth helpers for API routes
├── tests/                    Vitest suites (HMAC signatures, queue payload validation)
├── supabase/
│   └── migrations/
│       └── 001_init.sql      jobs + webhooks schema (RLS enabled)
├── .env.example              Zero-cost service keys (Supabase, Upstash, Gemini)
└── package.json              npm workspaces monorepo root
```

## API

All routes require `Authorization: Bearer <supabase-access-token>` (the user's
session JWT). Users only ever see their own rows.

| Route               | Method | Description                                                    |
| ------------------- | ------ | -------------------------------------------------------------- |
| `/api/jobs/upload`  | POST   | Multipart `file` field; returns `202 { job_id, status }`       |
| `/api/jobs/:id`     | GET    | Live `{ job_id, status, progress, result, error, timestamps }` |

The upload route validates PDF magic bytes, caps files at 20 MB (Gemini's inline
ceiling), rolls back the stored object if the job insert fails, and marks the row
`failed` if enqueueing fails — a job is never silently stuck in `pending`.

## Worker Pipeline

Per `doc.extract` job: mark `processing` → fetch a fresh 60s signed URL →
download the PDF → `progress 25%` → send to `gemini-3.6-flash` (structured JSON,
temperature 0) → `progress 50%` → persist `result_json` + `100%` → enqueue webhook
deliveries. Progress is written to **both** Redis (`job.updateProgress`) and
Postgres, so `GET /api/jobs/:id` reflects it in real time. Failures re-throw so
the queue's backoff policy applies; the process-level `failed` listener handles
final-attempt bookkeeping and DLQ routing.

## Queue Pipeline

- **Primary queue** `ingestio.docs` — job `doc.extract`.
- **Webhook queue** `ingestio.webhooks` — job `webhook.deliver`, enqueued on job
  completion/failure, with its own retry budget (3 attempts).
- **Dead-letter queue** `ingestio.docs.dlq` — nothing auto-retries from here;
  entries carry the original payload plus error metadata for inspection/replay.

### Retry & Backoff

Exponential backoff, max **3 attempts**, via a custom `backoffStrategy` (BullMQ's
built-in strategies can't inspect the error, so 429s get their own schedule):

| Failure type          | Delays between attempts | Give up after |
| --------------------- | ----------------------- | ------------- |
| Generic (5xx, network)| 2s → 4s → 8s            | ~14s          |
| Rate-limited (429)    | 60s → 120s → 240s       | ~7 min        |

### Failure Routing

BullMQ emits `failed` after every failed attempt; the worker only acts on the
final one (`attemptsMade >= opts.attempts` or an unrecoverable error):

1. Mark the `jobs` row `failed` with the error message (extraction only — a
   failed webhook delivery must not flip a completed job).
2. Add the payload + failure metadata to `ingestio.docs.dlq`.
3. `removeOnComplete` / `removeOnFail` cap retained job history so the free
   Upstash tier doesn't fill up.

### Idempotency

The BullMQ `jobId` is derived from the `jobs` row PK (`ingestio-<id>`; hyphen, since
BullMQ forbids colons in custom jobIds), so
re-enqueuing the same document is a no-op.

## Webhooks

- `signPayload` — HMAC-SHA256 of `` `${timestamp}.${body}` `` using the endpoint's
  `secret_key`.
- `dispatchWebhook` — POSTs the payload signed over `timestamp.body`, with the
  signature in `X-IngestIO-Signature`, the dispatch time (epoch ms) in
  `X-IngestIO-Timestamp`, and the event in `X-IngestIO-Event`; non-2xx throws so
  the delivery queue retries.
- `verifyWebhookSignature` (`lib/webhooks/verifier.ts`) — constant-time check for
  the receiving side that also rejects timestamps outside a 5-minute freshness
  window (replay protection).
- `enqueueWebhookDeliveries` — loads the user's endpoints subscribed to an event
  and enqueues one `webhook.deliver` per target.

## Database

- **`jobs`** — `id`, `user_id` (FK → `auth.users`, cascade delete), `status`
  (`pending | processing | completed | failed`), `payload_url` (storage object
  path), `progress` (0–100), `result_json` (jsonb), `error`, timestamps. Indexed
  on `user_id` and `(status, created_at desc)`.
- **`webhooks`** — `id`, `user_id`, `target_url`, `secret_key`, `event_type`
  (`job.completed | job.failed`), timestamps, unique on
  `(user_id, event_type, target_url)`.
- **RLS** enabled on both tables (`auth.uid() = user_id`). The worker and API
  routes write via the service-role key, which bypasses RLS; the `anon` role gets
  no grants.

> `user_id` referencing `auth.users` is Supabase-specific; for a standalone
> Postgres deployment, swap in your own users table.

## Setup Guide

All three services have free tiers — no credit card required.

### 1. Supabase (Postgres, Auth, Storage)

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign in
   with GitHub.
2. Create an organization (free plan), then **New project**: pick a name, a
   region close to your users, and set a database password.
3. Once provisioned, open **Project Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret** key → `SUPABASE_SERVICE_ROLE_KEY` (server-only!)
4. Apply the schema (either way works):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npm run db:migrate        # runs `supabase db push`
   ```
   …or paste the contents of `supabase/migrations/001_init.sql` into the
   **SQL Editor** in the dashboard.
5. Users authenticate with Supabase Auth (email OTP, magic link, etc.). The
   client's access-token JWT goes in the `Authorization: Bearer …` header.

### 2. Upstash (Redis for BullMQ)

1. Go to [upstash.com](https://upstash.com) → sign up (GitHub) → **Create
   database**.
2. Name it, pick a region (TLS is on by default). From the **Connect** tab copy:
   - **Redis URL** (`rediss://default:…`) → `UPSTASH_REDIS_URL`
   - **REST URL** → `UPSTASH_REDIS_REST_URL`
   - **REST Token** → `UPSTASH_REDIS_REST_TOKEN`
3. Free tier: 256 MB and 10,000 commands/day. The queue caps retained job history
   (`removeOnComplete`/`removeOnFail`) to stay comfortably inside it.

### 3. Google AI Studio (Gemini)

1. Go to [aistudio.google.com](https://aistudio.google.com) → sign in → **Get
   API key**.
2. Choose a Google Cloud project (or create one) → **Create API key**.
3. Copy it to `GEMINI_API_KEY`. The free tier includes `gemini-3.6-flash` with a
   generous daily request quota — enough for hundreds of extractions per day.
4. Optional: set `GEMINI_MODEL` to pin a different model (e.g.
   `models/gemini-3.6-flash` is also accepted — a leading `models/` prefix is
   stripped automatically). Defaults to `gemini-3.6-flash`.

## Getting Started

```bash
npm install

cp .env.example apps/web/.env
cp .env.example apps/worker/.env
# fill in Supabase / Upstash / Gemini keys from the Setup Guide above

npm run db:migrate   # or paste supabase/migrations/001_init.sql into the SQL Editor

npm run dev:worker   # BullMQ worker (tsx watch)
npm run dev:web      # Next.js on :3000
```

Upload a document:

```bash
curl -X POST http://localhost:3000/api/jobs/upload \
  -H "Authorization: Bearer <supabase-access-token>" \
  -F "file=@invoice.pdf"            # → 202 { "job_id": "...", "status": "pending" }

curl http://localhost:3000/api/jobs/<job_id> \
  -H "Authorization: Bearer <supabase-access-token>"   # → live status/progress
```

## Testing

[Vitest](https://vitest.dev) suites live in `tests/`:

```bash
npm test                 # run all suites
npm run test:watch       # watch mode
```

Covered: HMAC signature generation over `${timestamp}.${body}` (RFC 4231 key
material + fixed known vectors), replay protection (stale, future, and
malformed timestamps rejected; freshness window respected), signature
verification (tampered body, wrong secret, missing/different-length
signatures), webhook header contracts (`X-IngestIO-Signature`,
`X-IngestIO-Timestamp`, `X-IngestIO-Event`), webhook payload construction, and
queue payload validation for both `ExtractJobData` and `WebhookDeliveryData`. A
live BullMQ round-trip runs when `TEST_REDIS_URL` is set (e.g. a local Redis or
a throwaway Upstash database):

```bash
TEST_REDIS_URL=rediss://default:...@... npm test
```

Typecheck the whole monorepo (root + all workspaces) with `npm run typecheck`.

## Security

- **No secrets in the repo** — all keys come from environment variables
  (`.env.example` only contains placeholders); `.gitignore` excludes `.env`,
  `.env.local`, and `node_modules/`.
- **RLS on every table** — users can only read/write their own rows; the
  service-role key is used exclusively server-side and never shipped to the
  browser.
- **Signed webhooks** — payloads are HMAC-SHA256 signed with per-endpoint
  secrets over `${timestamp}.${body}`; recipients verify with constant-time
  comparison and reject timestamps older than 5 minutes (replay protection).
- **Upload rate limiting** — a sliding-window limiter (5 req/min per user/IP)
  backed by Upstash Redis returns `429` with `X-RateLimit-*` headers.
- **Strict HTTP headers** — `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy`, HSTS, and `Permissions-Policy` are applied to
  every route.
- **Sanitized worker logs** — credentials, API keys, and bearer tokens are
  masked before anything reaches stdout/log drains.
- **Fail-fast payloads** — malformed queue payloads fail immediately
  (`UnrecoverableError`), skipping wasteful retries.
- **Rate-limit hygiene** — 429s get their own long backoff schedule instead of
  hammering the provider.

## Roadmap

- Upload UI + dashboard with live progress (Supabase Realtime on `jobs`)
- DLQ replay UI and manual re-enqueue
- `supabase gen types typescript` for typed DB clients
- Gemini Files API for documents over 20 MB
- Storage cleanup job for orphaned payloads

## Contributing

Contributions are welcome. Before opening a PR: `npm run typecheck` and
`npm test`. Keep changes focused, document new environment variables in
`.env.example`, and add tests for anything touching signatures or queue payloads.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file
for details.
