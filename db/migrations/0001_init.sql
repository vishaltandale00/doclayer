-- doclayer v1 on Neon (Vercel Postgres)
--
-- Consolidates the 5 Supabase migrations into one Neon-targeted schema:
--   20260512000000_variants_v1
--   20260512000001_versions_unique
--   20260513000000_variants_public_handle  (SECURITY DEFINER view dropped — handle denormalized onto variants)
--   20260513000001_revision_variants
--   20260513000002_revision_variant_schema_fp
--
-- Changes vs Supabase version:
--   - No `auth.users` foreign key. user_id is now plain uuid (no FK).
--     The Supabase JWT verification step in lib/auth.ts validates that the
--     user_id we write came from a real Supabase session.
--   - No `auth.uid()` references. RLS replaced with app-level checks in
--     each /api/* handler (read user_id from verified JWT, compare to row).
--   - No SECURITY DEFINER view for email_handle. Instead:
--       variants.email_handle TEXT NOT NULL — denormalized at variant-create
--       time from the JWT's email claim. No cross-DB join needed.
--   - No `on_auth_user_created` trigger on auth.users (we can't trigger on a
--     foreign DB). Replaced with a "create-on-first-write" pattern in the
--     auth helper: when an authed request arrives, lib/auth.ts upserts the
--     user's main variant if it doesn't exist.
--   - patches_enforce_immutable trigger preserved verbatim (pure-postgres).

-- =========================================================================
-- Tables
-- =========================================================================

create table if not exists variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null default 'main',
  is_public boolean not null default true,
  email_handle text not null,                    -- denormalized from JWT.email
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  variant_id uuid not null references variants(id) on delete cascade,
  scenario_id text not null,
  phase text,
  anchor jsonb not null,
  text text not null,
  architect_response text,
  routed_kind text check (routed_kind in ('constructive','critical','meta')),
  resolved boolean not null default false,
  -- revision-variant fields (Phase 6)
  kind text not null default 'feedback'
    check (kind in ('feedback','revision_variant')),
  target_block_id text,
  proposed_text text,
  revision_status text
    check (revision_status in ('proposed','accepted','rejected')),
  schema_fp text,
  created_at timestamptz not null default now(),
  constraint comments_revision_shape_ck check (
    kind = 'feedback'
    or (kind = 'revision_variant'
        and proposed_text is not null
        and char_length(proposed_text) <= 2000
        and revision_status is not null)
  )
);

create table if not exists patches (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id) on delete cascade,
  comment_id uuid references comments(id) on delete set null,
  scenario_id text not null,
  schema_fp text not null,
  spec jsonb not null,
  status text not null default 'proposed'
    check (status in ('proposed','applied','rejected','superseded')),
  superseded_by_id uuid references patches(id),
  stale boolean not null default false,
  applied_at timestamptz,
  proposed_by uuid not null,                     -- the user_id that proposed
  created_at timestamptz not null default now()
);

create table if not exists variant_doc_versions (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants(id) on delete cascade,
  doc jsonb not null,
  schema_fp text not null,
  patch_id uuid references patches(id) on delete set null,
  prior_version_id uuid references variant_doc_versions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists variant_patches_audit (
  id bigserial primary key,
  variant_id uuid not null references variants(id) on delete cascade,
  patch_id uuid references patches(id) on delete set null,
  user_id uuid,
  action text not null check (action in (
    'proposed','applied','rejected','undone','superseded','stale',
    'revision_proposed','revision_accepted','revision_rejected'
  )),
  detail jsonb,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- Indexes
-- =========================================================================

create index if not exists idx_variants_user on variants(user_id);
create index if not exists idx_variants_public on variants(is_public)
  where is_public = true;
create index if not exists idx_comments_variant_scenario
  on comments(variant_id, scenario_id);
create index if not exists idx_comments_user on comments(user_id);
create index if not exists idx_comments_open on comments(variant_id, scenario_id)
  where resolved = false;
create index if not exists idx_comments_created on comments(created_at desc);
create index if not exists idx_comments_revision
  on comments(variant_id, scenario_id, revision_status)
  where kind = 'revision_variant';
create index if not exists idx_comments_schema_fp on comments(schema_fp)
  where kind = 'revision_variant';
create index if not exists idx_patches_variant_scenario_status
  on patches(variant_id, scenario_id, status);
create index if not exists idx_patches_supersedes on patches(superseded_by_id)
  where superseded_by_id is not null;
create index if not exists idx_patches_schema_fp on patches(schema_fp);
create index if not exists idx_versions_variant
  on variant_doc_versions(variant_id, created_at desc);
create index if not exists idx_audit_variant
  on variant_patches_audit(variant_id, created_at desc);

-- Linear version history per variant — optimistic locking. Two requests racing
-- on the same prior_version_id fork the history; the constraint causes the
-- second writer to fail with a unique violation, which the apply endpoint
-- translates to 409 VERSION_FORK_DETECTED.
create unique index if not exists idx_versions_chain_unique
  on variant_doc_versions(variant_id, prior_version_id)
  where prior_version_id is not null;

create unique index if not exists idx_versions_genesis_unique
  on variant_doc_versions(variant_id)
  where prior_version_id is null;

-- =========================================================================
-- Triggers (patches immutability)
-- =========================================================================

create or replace function patches_enforce_immutable()
returns trigger language plpgsql
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
  if new.proposed_by is distinct from old.proposed_by then
    raise exception 'patches.proposed_by is immutable once proposed';
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

drop trigger if exists patches_enforce_immutable_trg on patches;
create trigger patches_enforce_immutable_trg
  before update on patches
  for each row execute function patches_enforce_immutable();
