-- Docket-native data export/deletion lifecycle for Entra-authenticated users.
-- This deliberately never attempts to delete Microsoft Entra identities.

alter table public.app_users
  add column if not exists docket_data_status text not null default 'active';

do $$
begin
  alter table public.app_users
    add constraint app_users_docket_data_status_check
    check (docket_data_status in ('active', 'deleted'));
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete restrict,
  requested_by_email text,
  reason text,
  status text not null default 'pending_legal_review'
    check (status in ('pending_legal_review', 'approved', 'rejected', 'completed', 'cancelled')),
  legal_hold boolean not null default false,
  retention_until timestamptz,
  decision_note text,
  workflow_submission_disposition text not null default 'retain'
    check (workflow_submission_disposition in ('retain', 'anonymize', 'delete')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz,
  reviewed_by_user_id text,
  executed_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists data_deletion_requests_user_requested_idx
  on public.data_deletion_requests(user_id, requested_at desc);

create unique index if not exists data_deletion_requests_one_active_request_per_user
  on public.data_deletion_requests(user_id)
  where status in ('pending_legal_review', 'approved');
