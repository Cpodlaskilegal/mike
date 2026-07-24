begin;

-- Docket owns PracticePanther approval state. The upstream MCP receives no
-- request until the initiating Docket user approves this exact encrypted call.
create table if not exists public.user_mcp_tool_approvals (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,
  user_id text not null references public.app_users(id) on delete cascade,
  actor_email text not null,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  connector_name text not null,
  tool_name text not null,
  openai_tool_name text not null,
  encrypted_arguments text not null,
  arguments_iv text not null,
  arguments_tag text not null,
  arguments_hash text not null,
  arguments_preview jsonb not null default '{}'::jsonb,
  policy_version text not null,
  status text not null default 'pending'
    check (status in (
      'pending',
      'executing',
      'succeeded',
      'failed',
      'indeterminate',
      'rejected',
      'expired'
    )),
  chat_id text,
  assistant_message_id text,
  assistant_run_id text,
  trace_id text,
  project_id text,
  tool_call_id text,
  expires_at timestamptz not null,
  decided_at timestamptz,
  executed_at timestamptz,
  error_message text,
  result_event jsonb,
  result_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_approvals_user_created
  on public.user_mcp_tool_approvals(user_id, created_at desc);

create index if not exists idx_user_mcp_tool_approvals_pending_expiry
  on public.user_mcp_tool_approvals(expires_at)
  where status = 'pending';

create index if not exists idx_user_mcp_tool_approvals_message_terminal
  on public.user_mcp_tool_approvals(assistant_message_id, chat_id, status)
  where
    assistant_message_id is not null
    and status in ('succeeded', 'failed', 'indeterminate', 'rejected', 'expired');

commit;
