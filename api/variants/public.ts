/**
 * GET /api/variants/public
 *
 * Replaces the `variants_public_with_handle` view query used by the variants
 * gallery (mocks/variants.html). Since `email_handle` is denormalized onto
 * the `variants` row now, we don't need the view's SECURITY DEFINER join
 * against auth.users — we just select directly.
 *
 * Cursor-based pagination on last_active_at desc. Pass `?cursor=<iso>` to
 * fetch the next page strictly older than the cursor; `?limit=50` (capped).
 *
 * Auth: any signed-in user can browse the public gallery. We still require
 * the JWT so anonymous scrapes don't get a free list of variant IDs.
 *
 * Response:
 *   {
 *     variants: [{ variant_id, variant_name, email_handle, user_id,
 *                  last_active_at, created_at }],
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

  // Single-variant lookup form: `?id=<uuid>` returns just that row (used by
  // patch-renderer.js to label the read-only browse banner). Keeps the
  // contract narrow — public variants only.
  const idParam = typeof req.query.id === 'string' ? req.query.id : '';
  if (idParam) {
    try {
      const row = await sql(
        `select id as variant_id, name as variant_name, email_handle,
                user_id, last_active_at, created_at
         from variants
         where id = $1 and is_public = true
         limit 1`,
        [idParam]
      );
      res.status(200).json({ variants: row, next_cursor: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      res.status(500).json({ error: 'db_query_failed', detail: msg });
    }
    return;
  }

  const rawCursor = req.query.cursor;
  const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;
  const rawLimit = req.query.limit;
  const limit = Math.min(50, Math.max(1, Number(rawLimit) || 50));

  try {
    const text = cursor
      ? `select id as variant_id, name as variant_name, email_handle,
                user_id, last_active_at, created_at
         from variants
         where is_public = true and last_active_at < $2
         order by last_active_at desc
         limit $1`
      : `select id as variant_id, name as variant_name, email_handle,
                user_id, last_active_at, created_at
         from variants
         where is_public = true
         order by last_active_at desc
         limit $1`;
    const variants = await sql(text, cursor ? [limit, cursor] : [limit]);
    const next_cursor = variants.length === limit
      ? (variants[variants.length - 1].last_active_at
          ? String(variants[variants.length - 1].last_active_at)
          : null)
      : null;
    res.status(200).json({ variants, next_cursor });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_query_failed', detail: msg });
  }
}
