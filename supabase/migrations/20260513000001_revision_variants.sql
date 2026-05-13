-- Revision-variant proposals (Phase 6: prose escape hatch).
--
-- Prose lives in Yjs sub-docs the DSL cannot mutate. When the architect
-- classifies a comment as a prose rewrite, it emits a revision-variant
-- proposal instead of a patch. We persist these alongside comments using a
-- `kind` discriminator so the existing comments RLS + UI threading carries
-- forward — no new table.
--
-- Lifecycle: kind='revision_variant' rows are proposed → accepted | rejected
-- by the variant owner. On accept, the client also writes the swap to its
-- localStorage so the prose change is visible on the next page load (mocks
-- have no real Yjs; this simulates the human-accept-in-live-editor step).

alter table public.comments
  add column if not exists kind text
    not null
    default 'feedback'
    check (kind in ('feedback','revision_variant'));

alter table public.comments
  add column if not exists target_block_id text;

alter table public.comments
  add column if not exists proposed_text text;

alter table public.comments
  add column if not exists revision_status text
    check (revision_status in ('proposed','accepted','rejected'));

-- Constraint: if kind='revision_variant' then proposed_text must be set.
-- Use a check so a buggy client can't write a half-formed row.
alter table public.comments
  add constraint comments_revision_shape_ck
    check (
      kind = 'feedback'
      or (kind = 'revision_variant'
          and proposed_text is not null
          and char_length(proposed_text) <= 2000
          and revision_status is not null)
    );

create index if not exists idx_comments_revision
  on public.comments(variant_id, scenario_id, revision_status)
  where kind = 'revision_variant';

-- RLS: revision-variant proposals follow the same read/insert rules as
-- regular comments (already covered by existing comments policies — any
-- signed-in user can propose on a public variant, anyone signed-in can read
-- public). Acceptance / rejection (UPDATE of revision_status) is restricted
-- to the variant owner — the architect of THIS variant — via a tighter
-- update policy. The existing comments_update_own only lets a user edit
-- their own comments; for revision-variant we want the variant owner to be
-- able to accept a proposal that was made by someone else (e.g. a reviewer
-- proposing a rewrite). Add a parallel policy.

create policy comments_revision_accept_owner on public.comments
  for update
  using (
    kind = 'revision_variant'
    and exists (
      select 1 from public.variants v
      where v.id = comments.variant_id
        and v.user_id = auth.uid()
    )
  )
  with check (
    kind = 'revision_variant'
    and exists (
      select 1 from public.variants v
      where v.id = comments.variant_id
        and v.user_id = auth.uid()
    )
  );

-- Audit action: extend the existing variant_patches_audit action enum.
-- Revision-variant accept/reject events should show up in "your patches"
-- alongside applied patches so the timeline is unified.
alter table public.variant_patches_audit
  drop constraint if exists variant_patches_audit_action_check;

alter table public.variant_patches_audit
  add constraint variant_patches_audit_action_check
    check (action in (
      'proposed','applied','rejected','undone','superseded','stale',
      'revision_proposed','revision_accepted','revision_rejected'
    ));
