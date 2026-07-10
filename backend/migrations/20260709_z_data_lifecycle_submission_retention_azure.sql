-- Workflow submissions are private review artifacts with their own retention
-- decision. A Docket data deletion must not silently remove them.

-- The CHECK travels with the column when this migration upgrades an older
-- data-lifecycle table. If the current base migration already created the
-- column, `if not exists` leaves its existing inline CHECK untouched.
alter table public.data_deletion_requests
  add column if not exists workflow_submission_disposition text not null default 'retain'
    check (workflow_submission_disposition in ('retain', 'anonymize', 'delete'));
