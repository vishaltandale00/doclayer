-- Phase 6 fix P1-5: persist schema_fp on revision-variant proposals.
--
-- The architect pins schema_fp on the revision-variant response envelope (so
-- a hostile architect can't smuggle a mismatched fingerprint), but the
-- previous propose endpoint didn't store it. Without persistence we can't
-- audit drift or reject a stale proposal at accept time.
--
-- This migration adds a nullable schema_fp column. Existing rows (proposed
-- before this migration) stay nullable; new revision-variant rows MUST carry
-- the current server-side fingerprint (validated by the propose endpoint).

alter table public.comments
  add column if not exists schema_fp text;

create index if not exists idx_comments_schema_fp
  on public.comments(schema_fp)
  where kind = 'revision_variant';
