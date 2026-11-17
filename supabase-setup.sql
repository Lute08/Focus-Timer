-- Ejecuta este SQL una sola vez en Supabase > SQL Editor.
create table if not exists public.littlefocus_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.littlefocus_states enable row level security;
drop policy if exists "Users can read their own Little Focus state" on public.littlefocus_states;
drop policy if exists "Users can insert their own Little Focus state" on public.littlefocus_states;
drop policy if exists "Users can update their own Little Focus state" on public.littlefocus_states;
create policy "Users can read their own Little Focus state" on public.littlefocus_states
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert their own Little Focus state" on public.littlefocus_states
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update their own Little Focus state" on public.littlefocus_states
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update on public.littlefocus_states to authenticated;
