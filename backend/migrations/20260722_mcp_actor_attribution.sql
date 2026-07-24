begin;

alter table public.user_mcp_tool_audit_logs
  add column if not exists actor_email text,
  add column if not exists action_kind text not null default 'read',
  add column if not exists target_refs jsonb not null default '{}'::jsonb,
  add column if not exists practicepanther_audit_note_id text,
  add column if not exists practicepanther_audit_status text not null default 'not_required',
  add column if not exists chat_id text,
  add column if not exists assistant_message_id text,
  add column if not exists assistant_run_id text,
  add column if not exists trace_id text,
  add column if not exists project_id text,
  add column if not exists tool_call_id text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.user_mcp_tool_audit_logs
  drop constraint if exists user_mcp_tool_audit_logs_status_check;
alter table public.user_mcp_tool_audit_logs
  add constraint user_mcp_tool_audit_logs_status_check
  check (status in ('pending', 'ok', 'error'));

alter table public.user_mcp_tool_audit_logs
  drop constraint if exists user_mcp_tool_audit_logs_action_kind_check;
alter table public.user_mcp_tool_audit_logs
  add constraint user_mcp_tool_audit_logs_action_kind_check
  check (action_kind in ('read', 'mutation'));

alter table public.user_mcp_tool_audit_logs
  drop constraint if exists user_mcp_tool_audit_logs_pp_audit_status_check;
alter table public.user_mcp_tool_audit_logs
  add constraint user_mcp_tool_audit_logs_pp_audit_status_check
  check (
    practicepanther_audit_status in (
      'not_required',
      'pending',
      'created',
      'finalized',
      'failed'
    )
  );

create index if not exists idx_user_mcp_tool_audit_logs_actor_created
  on public.user_mcp_tool_audit_logs(actor_email, created_at desc);

create index if not exists idx_user_mcp_tool_audit_logs_pp_note
  on public.user_mcp_tool_audit_logs(practicepanther_audit_note_id)
  where practicepanther_audit_note_id is not null;

create unique index if not exists idx_user_mcp_tool_audit_logs_run_tool_mutation
  on public.user_mcp_tool_audit_logs(assistant_run_id, tool_call_id)
  where
    action_kind = 'mutation'
    and assistant_run_id is not null
    and tool_call_id is not null;

create unique index if not exists idx_user_mcp_tool_audit_logs_message_tool_mutation
  on public.user_mcp_tool_audit_logs(assistant_message_id, tool_call_id)
  where
    action_kind = 'mutation'
    and assistant_message_id is not null
    and tool_call_id is not null;

commit;
