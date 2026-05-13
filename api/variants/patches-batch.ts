/**
 * POST /api/variants/patches-batch
 *
 * Returns applied + superseded patches across multiple variants. Used by the
 * variants gallery (mocks/variants.html) to build the per-card palette /
 * scenarios / counts in one roundtrip — replaces the prior in-clause
 * `supabase.from('patches').in('variant_id', ids)` query.
 *
 * Auth: required. Only public variants are returned to non-owners; the
 * caller's own variants always pass through.
 *
 * Request body:
 *   { variant_ids: string[] }      // up to 50
 *
 * Response:
 *   { patches: [{ id, variant_id, scenario_id, status, spec, applied_at }] }
 *
 * Errors:
 *   401 missing_authorization
 *   405 method_not_allowed
 *   422 invalid_body / too_many_ids
 *   500 db_query_failed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sql } from '../../lib/db.ts';

const UUID_RE = /^[0-9a-fA-F-]{8,}$/;
const MAX_IDS = 50;

interface Body { variant_ids?: unknown; }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(422).json({ error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { res.status(422).json({ error: 'invalid_body' }); return; }
  const body = raw as Body;
  if (!Array.isArray(body.variant_ids)) { res.status(422).json({ error: 'invalid_body', detail: 'variant_ids array required' }); return; }
  if (body.variant_ids.length > MAX_IDS) { res.status(422).json({ error: 'too_many_ids', max: MAX_IDS }); return; }
  const ids = body.variant_ids.filter(function (v): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
  });
  if (!ids.length) { res.status(200).json({ patches: [] }); return; }

  try {
    // Join against variants so we can filter on (is_public OR owned-by-caller)
    // in SQL — keeps the trust boundary inside the DB rather than in JS post-filter.
    const patches = await sql(
      `select p.id, p.variant_id, p.scenario_id, p.status, p.spec, p.applied_at
       from patches p
       join variants v on v.id = p.variant_id
       where p.variant_id = any($1::uuid[])
         and (v.is_public = true or v.user_id = $2)
       order by p.applied_at desc nulls last`,
      [ids, auth.user_id]
    );
    res.status(200).json({ patches });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_query_failed', detail: msg });
  }
}
