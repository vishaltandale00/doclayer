/**
 * POST /api/variants/revision-propose
 *
 * Persist a revision-variant proposal emitted by the architect. The proposal
 * is a prose rewrite anchored to a `data-prose` block — it cannot mutate the
 * variant manifest (prose lives in Yjs sub-docs the DSL doesn't touch).
 *
 * Stored on the `comments` table with kind='revision_variant'. RLS lets any
 * signed-in user propose against a public variant; only the owner can accept.
 *
 * Request body:
 *   { variant_id, scenario_id, viewer_comment_id?, target_block_id,
 *     suggested_text, rationale?, intent? }
 *
 * Errors:
 *   400 missing/invalid fields
 *   401 unauthorized
 *   403 forbidden (private variant, not owner)
 *   500 db error
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServiceClient, getUserFromAuthHeader } from '../../lib/supabase-server.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { schemaFingerprint } from '../../lib/schema-fp.ts';

const VALID_SCENARIOS = new Set<string>([
  '00-flow','01-bootstrap','02-planning','03-drafting','04-review',
  '05-publish','06-reader-harness','07-multiplayer','08-workstream',
  '09-review-loop','index',
]);

const CURRENT_SCHEMA_FP = schemaFingerprint(variantSchema as object);

// ---- Rate limiting (in-memory, per-user, 10/hour) ----
// Mirrors api/draft-feedback.ts. Best-effort across cold starts: a serverless
// function whose container is recycled loses bucket state, so worst case a
// caller gets a fresh allowance. Acceptable for the demo scale; for prod-grade
// we'd back this with Supabase. Keyed per-user (not per-IP) because the
// endpoint is authed.
interface Bucket { count: number; resetAt: number; }
const RATE_BUCKET: Map<string, Bucket> = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
function checkRate(userId: string): { ok: boolean; resetAt: number } {
  const now = Date.now();
  const existing = RATE_BUCKET.get(userId);
  if (!existing || existing.resetAt < now) {
    const fresh: Bucket = { count: 1, resetAt: now + RATE_WINDOW_MS };
    RATE_BUCKET.set(userId, fresh);
    return { ok: true, resetAt: fresh.resetAt };
  }
  if (existing.count >= RATE_LIMIT) {
    return { ok: false, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { ok: true, resetAt: existing.resetAt };
}

interface Body {
  variant_id?: string;
  scenario_id?: string;
  viewer_comment_id?: string;
  target_block_id?: string;
  suggested_text?: string;
  rationale?: string;
  intent?: string;
  anchor?: unknown;
  schema_fp?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const user = await getUserFromAuthHeader(req.headers.authorization);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

  // P0-3: per-user rate limit, 10/hour. Mirrors draft-feedback in-memory pattern.
  const rate = checkRate(user.id);
  if (!rate.ok) {
    const retryAfter = Math.ceil((rate.resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limit', retry_after_seconds: retryAfter });
    return;
  }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { res.status(400).json({ error: 'body_not_object' }); return; }
  const body = raw as Body;

  if (typeof body.variant_id !== 'string') { res.status(400).json({ error: 'missing_variant_id' }); return; }
  if (typeof body.scenario_id !== 'string' || !VALID_SCENARIOS.has(body.scenario_id)) {
    res.status(400).json({ error: 'missing_or_invalid_scenario_id' }); return;
  }
  if (typeof body.suggested_text !== 'string' || body.suggested_text.length < 1 || body.suggested_text.length > 2000) {
    res.status(400).json({ error: 'invalid_suggested_text' }); return;
  }
  const targetBlock = typeof body.target_block_id === 'string' ? body.target_block_id : '';
  const intent = typeof body.intent === 'string' && body.intent.length <= 300 ? body.intent : 'rewrite proposed';

  // P1-5: schema_fp validation. The architect pins schema_fp on the
  // revision-variant response envelope; the client forwards it here. We
  // reject a stale fingerprint with 409 SCHEMA_STALE so a long-running
  // session catches a schema bump before persisting a divergent proposal.
  // Backward compat: callers that omit schema_fp are accepted (and the row
  // stores null) so existing clients keep working until they upgrade.
  if (body.schema_fp !== undefined) {
    if (typeof body.schema_fp !== 'string') {
      res.status(400).json({ error: 'invalid_schema_fp' }); return;
    }
    if (body.schema_fp !== CURRENT_SCHEMA_FP) {
      res.status(409).json({
        error: 'SCHEMA_STALE',
        expected: CURRENT_SCHEMA_FP,
        received: body.schema_fp,
      });
      return;
    }
  }
  const schemaFpToPersist = body.schema_fp === CURRENT_SCHEMA_FP ? CURRENT_SCHEMA_FP : null;

  const supa = getServiceClient();

  // Verify variant exists + viewer is allowed to propose. Either the variant
  // is public (any signed-in user may propose) or the caller is the owner.
  const variantQ = await supa.from('variants').select('id, user_id, is_public').eq('id', body.variant_id).maybeSingle();
  if (variantQ.error || !variantQ.data) { res.status(404).json({ error: 'variant_not_found' }); return; }
  const variant = variantQ.data as { id: string; user_id: string; is_public: boolean };
  if (!variant.is_public && variant.user_id !== user.id) {
    res.status(403).json({ error: 'forbidden' }); return;
  }

  // Stash the architect rationale + anchor + viewer_comment_id alongside the
  // proposal text. The `text` column is the human-readable proposal line; the
  // proposed_text column is the actual rewrite we'll swap in on accept.
  const headline = intent;
  const insertQ = await supa.from('comments').insert({
    user_id: user.id,
    variant_id: body.variant_id,
    scenario_id: body.scenario_id,
    phase: null,
    anchor: body.anchor ?? { kind: 'prose-block', target_block_id: targetBlock },
    text: headline,
    architect_response: typeof body.rationale === 'string' ? body.rationale : null,
    routed_kind: 'constructive',
    kind: 'revision_variant',
    target_block_id: targetBlock || null,
    proposed_text: body.suggested_text,
    revision_status: 'proposed',
    schema_fp: schemaFpToPersist,
  }).select('id').single();

  if (insertQ.error || !insertQ.data) {
    res.status(500).json({ error: 'db_insert_failed', detail: insertQ.error?.message }); return;
  }

  // Audit log — surfaces in "your patches" alongside applied patches so the
  // viewer can see their full architect timeline in one place.
  await supa.from('variant_patches_audit').insert({
    variant_id: body.variant_id,
    patch_id: null,
    user_id: user.id,
    action: 'revision_proposed',
    detail: {
      comment_id: insertQ.data.id,
      scenario_id: body.scenario_id,
      target_block_id: targetBlock || null,
      intent,
    },
  });

  res.status(200).json({
    comment_id: insertQ.data.id,
    revision_status: 'proposed',
    target_block_id: targetBlock,
  });
}
