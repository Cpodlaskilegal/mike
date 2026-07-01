alter table public.app_users
  add column if not exists role text not null default 'user';

do $$
begin
  alter table public.app_users
    add constraint app_users_role_check check (role in ('user', 'admin'));
exception
  when duplicate_object then null;
end
$$;

update public.app_users
set role = 'admin', updated_at = now()
where id = (
  select id
  from public.app_users
  order by created_at asc
  limit 1
)
and not exists (
  select 1
  from public.app_users
  where role = 'admin'
);
