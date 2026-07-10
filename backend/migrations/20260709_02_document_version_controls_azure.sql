-- Docket-native document-version controls.
--
-- This is intentionally separate from account lifecycle work: a version
-- tombstone records a user action against document bytes, while Entra account
-- identity and legal-retention policy remain governed by the data-lifecycle
-- flow. app_users.id is text in Docket, so deleted_by must not use upstream's
-- Supabase UUID assumption.

alter table public.document_versions
  alter column storage_path drop not null;

alter table public.document_versions
  add column if not exists file_type text,
  add column if not exists size_bytes integer,
  add column if not exists page_count integer,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text references public.app_users(id) on delete set null;

-- Existing Docket rows describe the same bytes as their parent document.
-- Backfill only missing values so this remains safe for repeatable deployment.
update public.document_versions dv
set
  file_type = coalesce(nullif(btrim(dv.file_type), ''), d.file_type),
  size_bytes = coalesce(dv.size_bytes, d.size_bytes),
  page_count = coalesce(dv.page_count, d.page_count)
from public.documents d
where dv.document_id = d.id
  and (
    dv.file_type is null
    or btrim(dv.file_type) = ''
    or dv.size_bytes is null
    or dv.page_count is null
  );

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;
