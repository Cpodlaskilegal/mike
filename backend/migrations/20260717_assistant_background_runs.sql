-- Durable lifecycle metadata for assistant responses. All modes are tracked so
-- cancellation is replica-safe; Pro/Max can additionally continue detached.
-- The stream request UUID is shared by the browser, route, logs, and provider
-- polling code so a detached response can be found again after reconnect.

create table if not exists public.assistant_background_runs (
  stream_request_id uuid primary key,
  assistant_message_id uuid not null unique
    references public.chat_messages(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  provider_response_id text,
  provider_request_id text,
  iteration integer not null default 1 check (iteration >= 1),
  status text not null default 'starting'
    check (status in (
      'starting',
      'queued',
      'in_progress',
      'background_pending',
      'cancel_requested',
      'running_tools',
      'finalizing',
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    )),
  provider_status text
    check (
      provider_status is null
      or provider_status in (
        'queued',
        'in_progress',
        'completed',
        'failed',
        'cancelled',
        'incomplete'
      )
    ),
  model text not null,
  reasoning_mode text,
  reasoning_effort text,
  trace_id text not null,
  revision text not null,
  finalization_owner uuid,
  error_code text,
  safe_error_message text,
  request_started_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists assistant_background_runs_chat_status_idx
  on public.assistant_background_runs(chat_id, status, updated_at desc);

create index if not exists assistant_background_runs_user_status_idx
  on public.assistant_background_runs(user_id, status, updated_at desc);

create unique index if not exists assistant_background_runs_provider_response_idx
  on public.assistant_background_runs(provider_response_id)
  where provider_response_id is not null;
