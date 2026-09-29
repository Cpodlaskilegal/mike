-- Add immutable source-build attribution to existing assistant run rows.
-- NULL denotes a run started before a deploy supplied GIT_COMMIT_SHA.
alter table public.assistant_background_runs
  add column if not exists git_sha text;
