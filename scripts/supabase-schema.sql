-- Run in Supabase SQL Editor
create table if not exists public.my_list (
  user_id uuid not null references auth.users(id) on delete cascade,
  anime_id bigint not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id)
);

create table if not exists public.continue_watching (
  user_id uuid not null references auth.users(id) on delete cascade,
  anime_id bigint not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id)
);

alter table public.my_list enable row level security;
alter table public.continue_watching enable row level security;

drop policy if exists "my_list_select_own" on public.my_list;
drop policy if exists "my_list_upsert_own" on public.my_list;
drop policy if exists "my_list_delete_own" on public.my_list;

create policy "my_list_select_own" on public.my_list
for select using (auth.uid() = user_id);

create policy "my_list_upsert_own" on public.my_list
for insert with check (auth.uid() = user_id);

create policy "my_list_update_own" on public.my_list
for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "my_list_delete_own" on public.my_list
for delete using (auth.uid() = user_id);

drop policy if exists "cw_select_own" on public.continue_watching;
drop policy if exists "cw_upsert_own" on public.continue_watching;
drop policy if exists "cw_delete_own" on public.continue_watching;

create policy "cw_select_own" on public.continue_watching
for select using (auth.uid() = user_id);

create policy "cw_upsert_own" on public.continue_watching
for insert with check (auth.uid() = user_id);

create policy "cw_update_own" on public.continue_watching
for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "cw_delete_own" on public.continue_watching
for delete using (auth.uid() = user_id);