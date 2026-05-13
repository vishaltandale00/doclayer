-- variants v1: one row per (user, variant_name). v1 = one variant per user, name='main'.
create table public.variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null default 'main',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (user_id, name)
);

-- comments: anchored design feedback. Belongs to a variant.
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  variant_id uuid references public.variants(id) on delete cascade not null,
  scenario_id text not null,
  phase text,
  anchor jsonb not null,
  text text not null,
  architect_response text,
  routed_kind text check (routed_kind in ('constructive','critical','meta')),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- patches: structured mutations proposed by architect, optionally applied to a variant.
create table public.patches (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid references public.variants(id) on delete cascade not null,
  comment_id uuid references public.comments(id) on delete set null,
  scenario_id text not null,
  schema_fp text not null,
  spec jsonb not null,
  status text not null default 'proposed' check (status in ('proposed','applied','rejected','superseded')),
  superseded_by_id uuid references public.patches(id),
  stale boolean not null default false,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

-- variant_doc_versions: immutable history of variant state after each applied patch.
create table public.variant_doc_versions (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid references public.variants(id) on delete cascade not null,
  doc jsonb not null,
  schema_fp text not null,
  patch_id uuid references public.patches(id) on delete set null,
  prior_version_id uuid references public.variant_doc_versions(id) on delete set null,
  created_at timestamptz not null default now()
);

-- variant_patches_audit: append-only log for the apply pipeline.
create table public.variant_patches_audit (
  id bigserial primary key,
  variant_id uuid references public.variants(id) on delete cascade not null,
  patch_id uuid references public.patches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('proposed','applied','rejected','undone','superseded','stale')),
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Indexes
create index idx_variants_user on public.variants(user_id);
create index idx_variants_public on public.variants(is_public) where is_public = true;
create index idx_comments_variant_scenario on public.comments(variant_id, scenario_id);
create index idx_comments_user on public.comments(user_id);
create index idx_patches_variant_scenario_status on public.patches(variant_id, scenario_id, status);
create index idx_patches_supersedes on public.patches(superseded_by_id) where superseded_by_id is not null;
create index idx_patches_schema_fp on public.patches(schema_fp);
create index idx_comments_open on public.comments(variant_id, scenario_id) where resolved = false;
create index idx_comments_created on public.comments(created_at desc);
create index idx_versions_variant on public.variant_doc_versions(variant_id, created_at desc);
create index idx_audit_variant on public.variant_patches_audit(variant_id, created_at desc);

-- RLS
alter table public.variants enable row level security;
alter table public.comments enable row level security;
alter table public.patches enable row level security;
alter table public.variant_doc_versions enable row level security;
alter table public.variant_patches_audit enable row level security;

create policy variants_select_public on public.variants
  for select using (is_public or user_id = auth.uid());
create policy variants_insert_own on public.variants
  for insert with check (user_id = auth.uid());
create policy variants_update_own on public.variants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy variants_delete_own on public.variants
  for delete using (user_id = auth.uid());

create policy comments_select_public on public.comments
  for select using (
    exists (select 1 from public.variants v where v.id = comments.variant_id and (v.is_public or v.user_id = auth.uid()))
  );
-- Any signed-in user can comment on a public variant; only the owner can comment on a private variant.
-- The user_id = auth.uid() check ensures you can't impersonate someone else's authorship.
create policy comments_insert_own on public.comments
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.variants v where v.id = variant_id and (v.is_public or v.user_id = auth.uid()))
  );
-- You can only edit / resolve your own comments.
create policy comments_update_own on public.comments
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- You can only delete your own comments.
create policy comments_delete_own on public.comments
  for delete using (user_id = auth.uid());

create policy patches_select_public on public.patches
  for select using (
    exists (select 1 from public.variants v where v.id = patches.variant_id and (v.is_public or v.user_id = auth.uid()))
  );
-- Any signed-in user can propose a patch against a public variant; only the owner can propose
-- patches on a private variant. Application code is responsible for tagging the proposer's
-- identity (patches.spec / comment_id link).
create policy patches_insert_own on public.patches
  for insert with check (
    exists (select 1 from public.variants v where v.id = variant_id and (v.is_public or v.user_id = auth.uid()))
  );
-- Only the variant owner can update patch status (apply/reject/supersede) — keeps editorial
-- control with the architect of the variant.
create policy patches_update_own on public.patches
  for update using (
    exists (select 1 from public.variants v where v.id = patches.variant_id and v.user_id = auth.uid())
  );
-- Only the variant owner can delete patches on their variant. We intentionally do NOT let
-- proposers delete their own patches — once a patch is on the board it's part of the
-- architect's record. Owners can clean up.
create policy patches_delete_own on public.patches
  for delete using (
    variant_id in (select id from public.variants where user_id = auth.uid())
  );

create policy versions_select_public on public.variant_doc_versions
  for select using (
    exists (select 1 from public.variants v where v.id = variant_doc_versions.variant_id and (v.is_public or v.user_id = auth.uid()))
  );
create policy versions_insert_service on public.variant_doc_versions
  for insert with check (false);

create policy audit_select_own on public.variant_patches_audit
  for select using (user_id = auth.uid());
create policy audit_insert_service on public.variant_patches_audit
  for insert with check (false);

-- Patches are immutable in their proposal form. Owners can only mutate lifecycle state
-- (status / superseded_by_id / stale / applied_at). Without this, patches_update_own
-- would let a variant owner silently rewrite the spec/comment_id/schema_fp of a
-- patch proposed by another user — breaking the editorial-trust model where the
-- architect controls *whether* a patch lands but never *what* it says.
create or replace function public.patches_enforce_immutable()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.spec is distinct from old.spec then
    raise exception 'patches.spec is immutable once proposed';
  end if;
  if new.comment_id is distinct from old.comment_id then
    raise exception 'patches.comment_id is immutable once proposed';
  end if;
  if new.schema_fp is distinct from old.schema_fp then
    raise exception 'patches.schema_fp is immutable once proposed';
  end if;
  if new.scenario_id is distinct from old.scenario_id then
    raise exception 'patches.scenario_id is immutable once proposed';
  end if;
  if new.variant_id is distinct from old.variant_id then
    raise exception 'patches.variant_id is immutable once proposed';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'patches.created_at is immutable';
  end if;
  if new.id is distinct from old.id then
    raise exception 'patches.id is immutable';
  end if;
  return new;
end;
$$;

create trigger patches_enforce_immutable_trg
  before update on public.patches
  for each row execute function public.patches_enforce_immutable();

-- Auto-create main variant on first sign-in via a trigger
create or replace function public.ensure_main_variant()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.variants (user_id, name, is_public)
  values (new.id, 'main', true)
  on conflict (user_id, name) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.ensure_main_variant();
