/**
 * GET /api/variants/patches?variant_id=<uuid>&scenario_id=<slug>&status=applied
 *
 * Fetches a variant's patches for a given scenario, ordered by applied_at
 * ascending. Used by mocks/patch-renderer.js to replay applied patches
 * against the live DOM on scenario load — including cross-variant browse
 * mode (`?variant=<id>` in the URL).
 *
 * Auth: required. Any signed-in user may read patches on a public variant
 * (mirrors the read-only browse intent). For non-public variants we restrict
 * to the owner.
 *
 * Query params:
 *   variant_id  required, the variant to load
 *   scenario_id required, the scenario to load
 *   status      optional, default 'applied'
 *
 * Response:
 *   { patches: [{ id, scenario_id, spec, status, applied_at,
 *                 superseded_by_id, variant_id }] }
 *
 * Errors:
 *   400 missing_param
 *   401 missing_authorization
 *   403 forbidden_variant
 *   404 variant_not_found
 *   405 method_not_allowed
 *   500 db_query_failed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sql, sqlOne } from '../../lib/db.ts';

const SCENARIO_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const UUID_RE = /^[0-9a-fA-F-]{8,}$/;
const STATUSES = new Set(['applied', 'superseded', 'undone']);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  const variantId = typeof req.query.variant_id === 'string' ? req.query.variant_id : '';
  const scenarioId = typeof req.query.scenario_id === 'string' ? req.query.scenario_id : '';
  const status = typeof req.query.status === 'string' ? req.query.status : 'applied';
  if (!variantId || !UUID_RE.test(variantId)) { res.status(400).json({ error: 'missing_param', detail: 'variant_id' }); return; }
  if (!scenarioId || !SCENARIO_RE.test(scenarioId)) { res.status(400).json({ error: 'missing_param', detail: 'scenario_id' }); return; }
  if (!STATUSES.has(status)) { res.status(400).json({ error: 'invalid_status' }); return; }

  try {
    // Ownership / public-read check. The auth'd user may always read their
    // own variant; for any other variant, it must be public.
    const variant = await sqlOne<{ user_id: string; is_public: boolean }>(
      `select user_id, is_public from variants where id = $1`,
      [variantId]
    );
    if (!variant) { res.status(404).json({ error: 'variant_not_found' }); return; }
    const isOwner = variant.user_id === auth.user_id;
    if (!isOwner && !variant.is_public) {
      res.status(403).json({ error: 'forbidden_variant' });
      return;
    }

    const patches = await sql(
      `select id, scenario_id, spec, status, applied_at, superseded_by_id, variant_id
       from patches
       where variant_id = $1 and scenario_id = $2 and status = $3
       order by applied_at asc`,
      [variantId, scenarioId, status]
    );
    res.status(200).json({ patches });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_query_failed', detail: msg });
  }
}
