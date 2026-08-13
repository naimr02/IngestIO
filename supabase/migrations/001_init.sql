-- ============================================================================
-- IngestIO — migration 001: initial schema
--
-- Multi-tenant background document operations:
--   • jobs     – lifecycle of an AI extraction task (upload → extract → done)
--   • webhooks – per-user notification endpoints fired on job completion/failure
--
-- Notes:
--   • gen_random_uuid() is built into PostgreSQL 13+ (no pgcrypto extension).
--   • Statuses are plain text + CHECK constraints so adding a status later is a
--     cheap DDL change (unlike ALTER TYPE ... ADD VALUE).
--   • Row Level Security is enabled on both tables. The Node worker writes via
--     the service-role key, which bypasses RLS.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- jobs — one row per document extraction task
-- ---------------------------------------------------------------------------
create table public.jobs (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users (id) on delete cascade,
    status       text not null default 'pending'
                 constraint jobs_status_check
                 check (status in ('pending', 'processing', 'completed', 'failed')),
    payload_url  text not null,                 -- signed object URL of the uploaded PDF
    progress     integer not null default 0
                 constraint jobs_progress_check
                 check (progress >= 0 and progress <= 100),
    result_json  jsonb,                          -- normalized Gemini extraction output
    error        text,                           -- last failure message (drives DLQ + webhooks)
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

comment on table public.jobs is 'Lifecycle of an AI document-extraction job.';
comment on column public.jobs.progress is 'Worker-reported progress percentage (0–100).';
comment on column public.jobs.result_json is 'Normalized extraction output; fields vary by document type.';

-- Worker polls pending jobs by status/recency; user dashboards filter by owner.
create index jobs_user_id_idx on public.jobs (user_id);
create index jobs_status_created_at_idx on public.jobs (status, created_at desc);
create index jobs_created_at_idx on public.jobs (created_at desc);

-- ---------------------------------------------------------------------------
-- webhooks — notification endpoints registered per user
-- ---------------------------------------------------------------------------
create table public.webhooks (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users (id) on delete cascade,
    target_url  text not null,
    secret_key  text not null,                 -- HMAC signing secret (X-IngestIO-Signature)
    event_type  text not null default 'job.completed'
                constraint webhooks_event_type_check
                check (event_type in ('job.completed', 'job.failed')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint webhooks_user_event_target_unique unique (user_id, event_type, target_url)
);

comment on column public.webhooks.secret_key is
    'HMAC secret used to sign outgoing payloads. Stored plaintext for the zero-cost '
    'MVP; rotate regularly and consider envelope encryption (pgcrypto / Vault) in production.';

create index webhooks_user_id_idx on public.webhooks (user_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger jobs_set_updated_at
    before update on public.jobs
    for each row execute function public.set_updated_at();

create trigger webhooks_set_updated_at
    before update on public.webhooks
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — users only ever see/own their own rows
-- ---------------------------------------------------------------------------
alter table public.jobs enable row level security;
alter table public.webhooks enable row level security;

create policy "jobs: users select own" on public.jobs
    for select using (auth.uid() = user_id);
create policy "jobs: users insert own" on public.jobs
    for insert with check (auth.uid() = user_id);
create policy "jobs: users update own" on public.jobs
    for update using (auth.uid() = user_id);
create policy "jobs: users delete own" on public.jobs
    for delete using (auth.uid() = user_id);

create policy "webhooks: users select own" on public.webhooks
    for select using (auth.uid() = user_id);
create policy "webhooks: users insert own" on public.webhooks
    for insert with check (auth.uid() = user_id);
create policy "webhooks: users update own" on public.webhooks
    for update using (auth.uid() = user_id);
create policy "webhooks: users delete own" on public.webhooks
    for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Grants — anon gets nothing; authenticated users CRUD their own rows; the
-- worker uses the service_role key (bypasses RLS).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.jobs to authenticated;
grant select, insert, update, delete on public.webhooks to authenticated;

commit;
