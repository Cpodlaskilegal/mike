-- Docket-native assistant contracts. This is intentionally additive: existing
-- annotation JSON remains available for tracked-change cards while citations
-- receive a richer, independently versioned representation.

alter table public.chat_messages
  add column if not exists citations jsonb;

alter table public.tabular_review_chat_messages
  add column if not exists citations jsonb;

-- Backfill only legacy citation annotations. Do not copy edit_data records:
-- those remain in annotations because document edit cards depend on them.
update public.chat_messages
set citations = legacy.citations
from (
  select
    id,
    jsonb_agg(annotation.value) filter (
      where annotation.value ->> 'type' = 'citation_data'
    ) as citations
  from public.chat_messages,
       lateral jsonb_array_elements(
         case
           when jsonb_typeof(annotations) = 'array' then annotations
           else '[]'::jsonb
         end
       ) as annotation(value)
  where citations is null
  group by id
) as legacy
where public.chat_messages.id = legacy.id
  and public.chat_messages.citations is null
  and legacy.citations is not null;

-- An Ask Inputs request has a stable server-owned ID and the exact structured
-- prompt the assistant emitted. The request is linked to the assistant
-- message so replay can show the same pending/completed prompt after reload.
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

-- A unique response row makes a completed request idempotent even if a
-- browser retries. The respondent is an Entra-backed app_users identity;
-- route-level chat/project access determines who may submit it.
create table if not exists public.assistant_input_responses (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique references public.assistant_input_requests(id) on delete cascade,
  submitted_by_user_id text not null references public.app_users(id) on delete cascade,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists assistant_input_responses_submitter_idx
  on public.assistant_input_responses(submitted_by_user_id, created_at desc);
