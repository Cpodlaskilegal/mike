-- Durable, content-free audit trail for first-party assistant tools.
-- The initial namespace is the signed-in user's own Microsoft mailbox.

alter table public.chats
  add column if not exists contains_mailbox_data boolean not null default false;

do $$
begin
  alter table public.chats
    add constraint chats_mailbox_data_private
    check (not contains_mailbox_data or project_id is null);
exception
  when duplicate_object then null;
end
$$;

create index if not exists idx_chats_mailbox_data_owner
  on public.chats(user_id)
  where contains_mailbox_data;

create table if not exists public.assistant_native_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  actor_email text,
  tool_namespace text not null
    check (tool_namespace in ('microsoft_graph_mail')),
  tool_name text not null
    check (tool_name in ('search_own_email', 'read_own_email')),
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'error')),
  error_code text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  target_ref_hash text,
  chat_id text,
  assistant_message_id text,
  assistant_run_id text,
  trace_id text,
  project_id text,
  tool_call_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_assistant_native_tool_audit_user_created
  on public.assistant_native_tool_audit_logs(user_id, created_at desc);

create index if not exists idx_assistant_native_tool_audit_run
  on public.assistant_native_tool_audit_logs(assistant_run_id, created_at desc)
  where assistant_run_id is not null;
