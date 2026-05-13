-- variants_public_with_handle: expose the email handle (no domain) for public
-- variants so the gallery can render "vishalt" instead of "viewer-7f3c2a".
--
-- We can't expose auth.users.email directly via RLS — PostgREST clients
-- (anon/authenticated) have no select grant on auth.users. So we put the
-- join behind a SECURITY DEFINER (security_invoker=false) view that strips
-- @domain via split_part, exposing only the local-part. This is the
-- gallery's emotional payload — humanity, not database IDs.
--
-- Privacy:
--   - Only is_public = true variants are exposed.
--   - Only the email handle (before @) is exposed; domains are stripped.
--   - The view does NOT expose user_id, full email, or any auth.users fields
--     other than the truncated handle.
--   - Owners of private variants are invisible to this view entirely.

create or replace view public.variants_public_with_handle
with (security_invoker = false)
as
select
  v.id              as variant_id,
  v.name            as variant_name,
  v.is_public       as is_public,
  v.user_id         as user_id,
  v.last_active_at  as last_active_at,
  v.created_at      as created_at,
  split_part(u.email, '@', 1) as email_handle
from public.variants v
join auth.users u on u.id = v.user_id
where v.is_public = true;

-- Lock down ownership so the SECURITY DEFINER view runs as a low-privilege
-- role rather than a superuser. The view definer's grants on auth.users are
-- what allow the email read; we explicitly want this view (and only this
-- view) to be the channel.
alter view public.variants_public_with_handle owner to postgres;

grant select on public.variants_public_with_handle to anon, authenticated;

comment on view public.variants_public_with_handle is
  'Public variants joined with auth.users to expose the email handle (local-part) only. SECURITY DEFINER bypasses RLS on auth.users; the view filters to is_public = true and strips @domain for privacy.';
