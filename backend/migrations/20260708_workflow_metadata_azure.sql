alter table public.workflows
  add column if not exists language text not null default 'English',
  add column if not exists jurisdictions text[] not null default array['General']::text[];

alter table public.workflows
  alter column practice set default 'General Transactions';

update public.workflows
set
  language = coalesce(nullif(trim(language), ''), 'English'),
  practice = coalesce(nullif(trim(practice), ''), 'General Transactions'),
  jurisdictions = coalesce(jurisdictions, array['General']::text[]);
