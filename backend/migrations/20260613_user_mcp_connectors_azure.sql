-- Azure-native MCP connector storage.
-- Uses public.app_users(id) text from the Entra/MSAL deployment, not Supabase auth.users.

create table if not exists public.user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  name text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http')),
  server_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth')),
  enabled boolean not null default true,
  tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text,
  auth_config_iv text,
  auth_config_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
  on public.user_mcp_connectors(user_id);

create table if not exists public.user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_type text,
  scope text,
  expires_at timestamptz,
  authorization_server text,
  token_endpoint text,
  client_id text,
  encrypted_client_secret text,
  client_secret_iv text,
  client_secret_tag text,
  resource text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id)
);

create table if not exists public.user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique,
  encrypted_state_config text not null,
  state_config_iv text not null,
  state_config_tag text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
  on public.user_mcp_oauth_states(expires_at);

create table if not exists public.user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_name text not null,
  openai_tool_name text not null,
  title text,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb,
  annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id, tool_name),
  unique(openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
  on public.user_mcp_connector_tools(connector_id);

create table if not exists public.user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  tool_name text not null,
  openai_tool_name text not null,
  status text not null check (status in ('ok', 'error')),
  error_message text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc);
