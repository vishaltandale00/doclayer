/**
 * DELETE /api/me/variant
 *
 * Hard-deletes the auth'd user's main variant. Cascade kills comments,
 * patches, versions per the FK setup. Replaces the prior client-side
 * `supabase.from('variants').delete()` in mocks/identity.js, which relied
 * on RLS — now that we're on Neon with app-level auth, we filter by
 * `user_id = auth.user_id` server-side.
 *
 * Response: 204 on success.
 *
 * Errors:
 *   401 missing_authorization / invalid_jwt
 *   405 method_not_allowed
 *   500 db_delete_failed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sql } from '../../lib/db.ts';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'DELETE') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  try {
    // Filter on BOTH id and user_id as belt-and-suspenders — even though
    // requireAuth only returned this user's variant_id, the WHERE clause
    // means a stale auth state can never delete someone else's row.
    await sql(
      `delete from variants where id = $1 and user_id = $2`,
      [auth.variant_id, auth.user_id]
    );
    res.status(204).end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_delete_failed', detail: msg });
  }
}
