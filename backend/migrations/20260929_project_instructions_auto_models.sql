-- Apply incrementally before deploying DCK-010 / DCK-011.
alter table public.chat_messages add column if not exists generation jsonb;
alter table public.projects
  add column if not exists instructions text not null default '',
  add column if not exists instruction_version integer not null default 0;
do $$
begin
  alter table public.projects add constraint projects_instructions_length_check check (char_length(instructions) <= 5000);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table public.projects add constraint projects_instruction_version_check check (instruction_version >= 0);
exception when duplicate_object then null;
end $$;

create table if not exists public.project_instruction_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null check (version > 0),
  instructions text not null check (char_length(instructions) <= 5000),
  edited_by_user_id text references public.app_users(id) on delete set null,
  editor_email text not null,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

alter table public.assistant_background_runs
  add column if not exists model_selection_mode text check (model_selection_mode in ('auto', 'manual')),
  add column if not exists model_selection_reason text,
  add column if not exists model_policy_version text,
  add column if not exists model_task text check (model_task in ('drafting', 'research', 'summary')),
  add column if not exists model_budget_policy text check (model_budget_policy in ('economy', 'balanced', 'quality')),
  add column if not exists project_instruction_version integer check (project_instruction_version >= 0);
