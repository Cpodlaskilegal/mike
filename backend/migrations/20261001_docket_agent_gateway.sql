-- Docket Agent gateway.
--
-- It only adds: one new table, two columns with defaults, one check, three
-- indexes. Nothing is dropped, renamed or rewritten.
-- Safe to run twice.
-- Safe in either order with the backend:
--   * run first, while the earlier backend is serving: that backend never
--     names the new columns, and every row it writes gets origin 'docket';
--   * run after the new backend is deployed: Docket chat writes no new
--     column, and the gateway stays off (503) until DOCKET_AGENT_OPS_TOKEN
--     is set. Run this before that variable is set.

begin;

-- The two changes to user_mcp_tool_audit_logs need that table to itself for
-- a moment. If something else holds it, give up after five seconds instead
-- of making Docket's own requests queue behind this file; nothing is changed
-- then, and the file can simply be run again.
set local lock_timeout = '5s';

-- One row per enrolment ever minted. It holds two tokens with two reaches:
-- the agent token for the MCP routes (token_hash) and the Box file token for
-- the Box file routes (file_token_hash). Only SHA-256 hashes are stored.
-- Revoking the row ends both.
create table if not exists public.docket_agent_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  -- The hash of the same enrolment's Box file token (dkf_...). It opens the
  -- Box file routes only. Null on a row minted before those routes existed.
  file_token_hash text unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

-- For a database where this file was run before the Box file token existed.
alter table public.docket_agent_tokens
  add column if not exists file_token_hash text unique;

-- A user has at most one live token. Minting a new one revokes the old one.
create unique index if not exists idx_docket_agent_tokens_one_active
  on public.docket_agent_tokens(user_id)
  where revoked_at is null;

-- A user has at most one connector per Docket Agent source. Only a row the
-- gateway makes for itself carries this mark (today: Quo). PracticePanther
-- and Box are served by Docket's own rows, which never carry it.
create unique index if not exists idx_user_mcp_connectors_docket_agent_source
  on public.user_mcp_connectors (user_id, (tool_policy->>'docketAgentSource'))
  where (tool_policy->>'docketAgentSource') is not null;

-- Tell Docket Agent calls apart from Docket chat calls in the audit log.
alter table public.user_mcp_tool_audit_logs
  add column if not exists origin text not null default 'docket',
  add column if not exists agent_token_id uuid;

do $$
begin
  alter table public.user_mcp_tool_audit_logs
    add constraint user_mcp_tool_audit_logs_origin_check
    check (origin in ('docket', 'docket_agent'));
exception when duplicate_object then null;
end $$;

create index if not exists idx_user_mcp_tool_audit_logs_agent_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc)
  where origin = 'docket_agent';

commit;
