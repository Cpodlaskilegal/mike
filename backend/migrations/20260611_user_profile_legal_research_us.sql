-- Per-user toggle for US legal research (CourtListener) tools in chat.

alter table public.user_profiles
  add column if not exists legal_research_us boolean not null default true;

alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'courtlistener', 'gemini', 'openai'));
