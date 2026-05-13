/**
 * GET /api/me/patches
 *
 * Returns the auth'd user's patches + accepted revision-variants for the
 * "your patches" timeline modal in identity.js. Replaces the prior direct
 * `supabase.from('patches')` / `supabase.from('comments')` queries that the
 * frontend used to issue, now that data lives in Neon behind app-level auth.
 *
 * Cursor-based pagination: pass `?cursor=<iso-timestamp>` to fetch rows
 * strictly older than that timestamp. The cursor is applied to BOTH streams
 * (patches by applied_at, revisions by created_at) so a single cursor walks
 * the merged timeline. `next_cursor` is the oldest timestamp from this page
 * if at least one stream returned a full page; null when both are drained.
 *
 * Response:
 *   {
 *     patches: [{ id, scenario_id, status, applied_at, spec, superseded_by_id }],
 *     revisions: [{ id, scenario_id, target_block_id, revision_status,
 *                   created_at, text, proposed_text }],
 *     next_cursor: string | null
 *   }
 *
 * Errors:
 *   401 missing_authorization / invalid_jwt
 *   405 method_not_allowed
 *   500 db_query_failed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sql } from '../../lib/db.ts';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  const rawCursor = req.query.cursor;
  const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;
  const rawLimit = req.query.limit;
  const limit = Math.min(50, Math.max(1, Number(rawLimit) || 20));

  try {
    // Patches: applied/superseded/undone — keep status so caller can render the
    // badge. Order by COALESCE(applied_at, created_at) so unappied rows (rare)
    // still get a stable timestamp.
    const patchSql = cursor
      ? `select id, scenario_id, status, applied_at, created_at, spec, superseded_by_id
         from patches
         where variant_id = $1 and coalesce(applied_at, created_at) < $3
         order by coalesce(applied_at, created_at) desc
         limit $2`
      : `select id, scenario_id, status, applied_at, created_at, spec, superseded_by_id
         from patches
         where variant_id = $1
         order by coalesce(applied_at, created_at) desc
         limit $2`;
    const patchesP = sql(patchSql, cursor ? [auth.variant_id, limit, cursor] : [auth.variant_id, limit]);

    // Revisions: accepted-only on the owner timeline (matches the existing
    // identity.js intent — pending proposals belong in an inbox view).
    const revSql = cursor
      ? `select id, scenario_id, target_block_id, revision_status, created_at,
                text, proposed_text
         from comments
         where variant_id = $1 and kind = 'revision_variant'
           and revision_status = 'accepted' and created_at < $3
         order by created_at desc
         limit $2`
      : `select id, scenario_id, target_block_id, revision_status, created_at,
                text, proposed_text
         from comments
         where variant_id = $1 and kind = 'revision_variant'
           and revision_status = 'accepted'
         order by created_at desc
         limit $2`;
    const revisionsP = sql(revSql, cursor ? [auth.variant_id, limit, cursor] : [auth.variant_id, limit]);

    const [patches, revisions] = await Promise.all([patchesP, revisionsP]);

    // next_cursor: only emit one if at least one stream returned a full page —
    // otherwise we've drained both and the "load more" button can hide.
    let next_cursor: string | null = null;
    if (patches.length === limit || revisions.length === limit) {
      const lastPatch = patches[patches.length - 1];
      const lastRev = revisions[revisions.length - 1];
      const lastPatchTs = lastPatch ? (lastPatch.applied_at || lastPatch.created_at) : null;
      const lastRevTs = lastRev ? lastRev.created_at : null;
      // Pick the OLDER of the two so the next page strictly continues both
      // streams. If only one stream has data, use it.
      if (lastPatchTs && lastRevTs) {
        next_cursor = String(lastPatchTs) < String(lastRevTs) ? String(lastPatchTs) : String(lastRevTs);
      } else {
        next_cursor = lastPatchTs ? String(lastPatchTs) : (lastRevTs ? String(lastRevTs) : null);
      }
    }

    res.status(200).json({
      patches,
      revisions,
      next_cursor,
      // Surface variant identity so the frontend hydrate flow can swap its
      // direct supabase.from('variants') lookup for a single authed roundtrip.
      // Cheap (no extra query — these came from requireAuth's idempotent insert).
      variant_id: auth.variant_id,
      email_handle: auth.email_handle,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_query_failed', detail: msg });
  }
}
