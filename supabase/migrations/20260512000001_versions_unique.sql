-- Enforce linear version history per variant: at most one row can have a given
-- (variant_id, prior_version_id) pair. This implements optimistic locking for
-- concurrent applies — two requests racing on the same prior version fork the
-- history; this constraint causes the second writer to fail with a unique
-- violation, which the apply endpoint translates to 409 VERSION_FORK_DETECTED.
--
-- prior_version_id is nullable for the genesis row; we want at most ONE genesis
-- per variant as well, so the partial index handles the NULL case explicitly.
create unique index idx_versions_chain_unique
  on public.variant_doc_versions(variant_id, prior_version_id)
  where prior_version_id is not null;

create unique index idx_versions_genesis_unique
  on public.variant_doc_versions(variant_id)
  where prior_version_id is null;
