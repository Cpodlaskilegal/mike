-- Apply to existing Docket databases before deploying the custom-instructions code.
alter table public.user_profiles
  add column if not exists personal_instructions text not null default '';

do $$
begin
  alter table public.user_profiles
    add constraint user_profiles_personal_instructions_length_check
      check (char_length(personal_instructions) <= 5000);
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.firm_instructions (
  id integer primary key default 1 check (id = 1),
  instructions text not null default '' check (char_length(instructions) <= 5000),
  updated_by_user_id text references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
