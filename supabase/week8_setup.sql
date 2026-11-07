-- Week 8 Prompt Chain Tool setup. Safe to run in the existing NYC Unhinged Supabase project.
-- Adds only generated-media persistence and explicit superadmin access policies.

alter table public.prompt_chains enable row level security;
alter table public.prompt_chain_steps enable row level security;

drop policy if exists "week8_superadmin_prompt_chains" on public.prompt_chains;
create policy "week8_superadmin_prompt_chains" on public.prompt_chains
for all to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true));

drop policy if exists "week8_superadmin_prompt_chain_steps" on public.prompt_chain_steps;
create policy "week8_superadmin_prompt_chain_steps" on public.prompt_chain_steps
for all to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true));

create table if not exists public.generated_media (
  id uuid primary key default gen_random_uuid(),
  chain_id uuid not null references public.prompt_chains(id) on delete cascade,
  prompt text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists generated_media_chain_created_idx on public.generated_media(chain_id, created_at desc);
alter table public.generated_media enable row level security;
drop policy if exists "week8_superadmin_generated_media" on public.generated_media;
create policy "week8_superadmin_generated_media" on public.generated_media
for all to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generated-media', 'generated-media', false, 20971520, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists "week8_superadmin_media_objects" on storage.objects;
create policy "week8_superadmin_media_objects" on storage.objects
for all to authenticated
using (bucket_id = 'generated-media' and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true))
with check (bucket_id = 'generated-media' and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_superadmin = true));
