-- Docket Azure PostgreSQL schema.
-- This is the fresh-database schema for the Azure-native deployment.

create table if not exists public.app_users (
  id text primary key,
  email text not null default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  docket_data_status text not null default 'active'
    check (docket_data_status in ('active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique references public.app_users(id) on delete cascade,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  tabular_model text not null default 'gpt-5.4-mini',
  legal_research_us boolean not null default true,
  claude_api_key text,
  gemini_api_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user on public.user_profiles(user_id);

-- A Docket data-deletion request is reviewed against legal retention before
-- any application data is removed. Microsoft Entra identities are never
-- deleted from this application workflow.
create table if not exists public.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete restrict,
  requested_by_email text,
  reason text,
  status text not null default 'pending_legal_review'
    check (status in ('pending_legal_review', 'approved', 'rejected', 'completed', 'cancelled')),
  legal_hold boolean not null default false,
  retention_until timestamptz,
  decision_note text,
  workflow_submission_disposition text not null default 'retain'
    check (workflow_submission_disposition in ('retain', 'anonymize', 'delete')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz,
  reviewed_by_user_id text,
  executed_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists data_deletion_requests_user_requested_idx
  on public.data_deletion_requests(user_id, requested_at desc);

create unique index if not exists data_deletion_requests_one_active_request_per_user
  on public.data_deletion_requests(user_id)
  where status in ('pending_legal_review', 'approved');

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'courtlistener', 'gemini', 'openai')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists idx_user_api_keys_user on public.user_api_keys(user_id);

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

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  name text not null,
  cm_number text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user on public.projects(user_id);
create index if not exists projects_shared_with_idx on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project on public.project_subfolders(project_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  filename text not null,
  file_type text,
  size_bytes integer not null default 0,
  page_count integer,
  structure_tree jsonb,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_user_project on public.documents(user_id, project_id);
create index if not exists idx_documents_project_folder on public.documents(project_id, folder_id);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  display_name text,
  file_type text,
  size_bytes integer,
  page_count integer,
  deleted_at timestamptz,
  deleted_by text references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text
    ]))
);

create index if not exists document_versions_document_id_idx on public.document_versions(document_id, created_at desc);
create index if not exists document_versions_doc_vnum_idx on public.document_versions(document_id, version_number);
create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array['pending'::text, 'accepted'::text, 'rejected'::text])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx on public.document_edits(document_id, created_at desc);
create index if not exists document_edits_message_id_idx on public.document_edits(chat_message_id);
create index if not exists document_edits_version_id_idx on public.document_edits(version_id);

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text references public.app_users(id) on delete cascade,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  language text not null default 'English',
  practice text default 'General Transactions',
  jurisdictions text[] not null default array['General']::text[],
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user on public.workflows(user_id);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users(id) on delete cascade,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id text not null references public.app_users(id) on delete cascade,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx on public.workflow_shares(workflow_id);
create index if not exists workflow_shares_email_idx on public.workflow_shares(shared_with_email);

-- Custom workflow submissions are private Docket review artifacts. System
-- workflow definitions remain application-owned, not user-editable database
-- rows; no anonymous/public database write path exists for this queue.
create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid references public.workflows(id) on delete set null,
  submitted_by_user_id text not null references public.app_users(id) on delete restrict,
  submitted_by_email text,
  attribution text not null default 'docket-community'
    check (attribution in ('named', 'docket-community')),
  public_name text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'accepted', 'declined', 'withdrawn')),
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_user_id text references public.app_users(id) on delete set null,
  withdrawn_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_named_attribution_check
    check (
      (attribution = 'named' and nullif(trim(coalesce(public_name, '')), '') is not null)
      or (attribution = 'docket-community')
    )
);

create unique index if not exists workflow_open_source_submissions_one_pending_per_workflow_user
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending_review';
create index if not exists workflow_open_source_submissions_reviewer_queue_idx
  on public.workflow_open_source_submissions(status, submitted_at desc);
create index if not exists workflow_open_source_submissions_submitter_idx
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user on public.chats(user_id);
create index if not exists idx_chats_project on public.chats(project_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  annotations jsonb,
  citations jsonb,
  workflow jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_messages
  add column if not exists workflow jsonb;

create index if not exists idx_chat_messages_chat on public.chat_messages(chat_id);

-- Rich assistant citations are kept apart from annotations so existing
-- tracked-change edit metadata stays backwards compatible. Ask Inputs are
-- durable, Entra-owned chat contracts rather than client-only pause state.
create table if not exists public.assistant_input_requests (
  id text primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  assistant_message_id uuid not null references public.chat_messages(id) on delete cascade,
  created_by_user_id text not null references public.app_users(id) on delete cascade,
  request jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists assistant_input_requests_chat_status_idx
  on public.assistant_input_requests(chat_id, status, created_at desc);
create index if not exists assistant_input_requests_message_idx
  on public.assistant_input_requests(assistant_message_id);

create table if not exists public.assistant_input_responses (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique references public.assistant_input_requests(id) on delete cascade,
  submitted_by_user_id text not null references public.app_users(id) on delete cascade,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_input_responses_submitter_idx
  on public.assistant_input_responses(submitted_by_user_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  system_workflow_id text,
  practice text,
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user on public.tabular_reviews(user_id);
create index if not exists idx_tabular_reviews_project on public.tabular_reviews(project_id);
create index if not exists tabular_reviews_system_workflow_id_idx on public.tabular_reviews(system_workflow_id) where system_workflow_id is not null;
create index if not exists tabular_reviews_shared_with_idx on public.tabular_reviews using gin (shared_with);

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review on public.tabular_cells(review_id, document_id, column_index);

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx on public.tabular_review_chats(review_id, updated_at desc);
create index if not exists tabular_review_chats_user_idx on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);

-- Docket-owned LLM spend accounting. The immutable event rows intentionally
-- retain financial totals while user/chat/project links can be anonymized by
-- the Docket data-lifecycle workflow.
create table if not exists public.llm_usage_events (
  id uuid primary key default gen_random_uuid(),
  account_key text not null default 'docket',
  provider text not null check (provider in ('openai', 'claude')),
  model text not null,
  provider_response_id text not null,
  billing_source text not null check (billing_source in ('account', 'user_api_key')),
  cost_status text not null check (cost_status in ('priced', 'unpriced')),
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_5m_tokens integer not null default 0,
  cache_creation_1h_tokens integer not null default 0,
  output_tokens integer not null default 0,
  input_cost_nanos bigint not null default 0,
  cached_input_cost_nanos bigint not null default 0,
  output_cost_nanos bigint not null default 0,
  total_cost_nanos bigint not null default 0,
  user_id text references public.app_users(id) on delete set null,
  route text,
  chat_id uuid references public.chats(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (provider, provider_response_id)
);

create index if not exists llm_usage_events_account_created_idx
  on public.llm_usage_events(account_key, created_at desc);
create index if not exists llm_usage_events_user_created_idx
  on public.llm_usage_events(user_id, created_at desc);

create table if not exists public.llm_spend_account_state (
  account_key text primary key,
  total_cost_nanos bigint not null default 0,
  gpt_cost_nanos bigint not null default 0,
  claude_cost_nanos bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.llm_spend_reports (
  id uuid primary key default gen_random_uuid(),
  account_key text not null,
  milestone_number integer not null check (milestone_number > 0),
  threshold_nanos bigint not null,
  reported_total_nanos bigint not null,
  gpt_cost_nanos bigint not null,
  claude_cost_nanos bigint not null,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'not_configured', 'failed')),
  delivery_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_key, milestone_number)
);

create index if not exists llm_spend_reports_account_created_idx
  on public.llm_spend_reports(account_key, created_at desc);

create table if not exists public.llm_spend_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.llm_spend_reports(id) on delete cascade,
  admin_user_id text references public.app_users(id) on delete set null,
  recipient_email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'not_configured', 'failed')),
  resend_email_id text,
  delivery_error text,
  attempt_count integer not null default 0,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id, recipient_email)
);

create index if not exists llm_spend_report_deliveries_report_idx
  on public.llm_spend_report_deliveries(report_id, created_at desc);
