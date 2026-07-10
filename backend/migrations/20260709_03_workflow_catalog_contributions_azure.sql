-- Docket-owned system workflows live in the application image. This table is
-- only a private, authenticated review queue for custom workflow submissions;
-- it does not create anonymous writes or publish to an external repository.

-- `workflow_id` remains a UUID foreign key for a custom workflow row. System
-- workflows have stable application IDs instead, so retain that provenance in
-- a separate text column rather than inventing fake database workflow rows.
alter table public.tabular_reviews
  add column if not exists system_workflow_id text;

create index if not exists tabular_reviews_system_workflow_id_idx
  on public.tabular_reviews(system_workflow_id)
  where system_workflow_id is not null;

create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references public.workflows(id) on delete set null,
  submitted_by_user_id text not null references public.app_users(id) on delete restrict,
  submitted_by_email text,
  attribution text not null default 'docket-community'
    check (attribution in ('named', 'docket-community')),
  public_name text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'accepted', 'declined', 'withdrawn')),
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_user_id text references public.app_users(id) on delete set null,
  withdrawn_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_named_attribution_check
    check (
      (attribution = 'named' and nullif(trim(coalesce(public_name, '')), '') is not null)
      or (attribution = 'docket-community')
    )
);

create unique index if not exists workflow_open_source_submissions_one_pending_per_workflow_user
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending_review';

create index if not exists workflow_open_source_submissions_reviewer_queue_idx
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists workflow_open_source_submissions_submitter_idx
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

-- There is intentionally no public database policy or anonymous API path.
-- Docket's Express API authenticates Microsoft Entra identities and enforces
-- owner/admin authorization before accessing this queue.
