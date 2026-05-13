/**
 * POST /api/variants/regenerate
 *
 * Re-invoke the architect with the current schema + fp when a previously
 * proposed patch has gone stale due to schema rotation. Marks the prior
 * patch row as stale and returns a fresh patch with the current schema_fp.
 *
 * Body: { comment_id: string, prior_patch_id: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServiceClient, getUserFromAuthHeader } from '../../lib/supabase-server.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import draftFeedback from '../draft-feedback.ts';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const user = await getUserFromAuthHeader(req.headers.authorization);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; } }
  const body = (raw ?? {}) as { comment_id?: string; prior_patch_id?: string };
  if (typeof body.comment_id !== 'string' || typeof body.prior_patch_id !== 'string') {
    res.status(400).json({ error: 'missing_fields' }); return;
  }

  const supa = getServiceClient();
  const { data: comment } = await supa
    .from('comments')
    .select('id, user_id, variant_id, scenario_id, phase, text')
    .eq('id', body.comment_id)
    .single();
  if (!comment) { res.status(404).json({ error: 'comment_not_found' }); return; }

  const { data: priorPatch } = await supa
    .from('patches')
    .select('id, variant_id, spec, schema_fp')
    .eq('id', body.prior_patch_id)
    .single();
  if (!priorPatch) { res.status(404).json({ error: 'prior_patch_not_found' }); return; }

  // Ownership check
  const { data: variantRow } = await supa
    .from('variants').select('id, user_id').eq('id', comment.variant_id).single();
  if (!variantRow || variantRow.user_id !== user.id) {
    res.status(403).json({ error: 'forbidden' }); return;
  }

  const currentFp = schemaFingerprint(variantSchema as object);
  const priorIntent = ((priorPatch.spec ?? {}) as { intent?: string }).intent ?? '';

  // Mark prior patch stale before re-invoking.
  await supa.from('patches').update({ stale: true }).eq('id', body.prior_patch_id);
  await supa.from('variant_patches_audit').insert({
    variant_id: comment.variant_id,
    patch_id: body.prior_patch_id,
    user_id: user.id,
    action: 'stale',
    detail: { reason: 'schema_rotated', prior_fp: priorPatch.schema_fp, current_fp: currentFp },
  });

  // Re-invoke draft-feedback with a contextual note prepended to the comment.
  // We mutate the request body in-place and forward to the existing handler.
  const augmented = {
    ...req,
    method: 'POST',
    body: {
      scenario: comment.scenario_id,
      phase: comment.phase ?? undefined,
      feedback:
        `[regenerate-after-schema-rotation prior_intent="${priorIntent}"] ` +
        (comment.text as string),
    },
    headers: req.headers,
  } as unknown as VercelRequest;

  // Forward to the draft-feedback handler. The updated handler will produce
  // the new patch with the current schema fingerprint.
  return draftFeedback(augmented, res);
}
