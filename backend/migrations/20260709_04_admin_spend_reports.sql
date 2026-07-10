-- Durable Docket-account LLM spend ledger and $100 report milestones.
-- The server keeps the source of truth; PostHog receives a mirror for analysis.

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
