/**
 * POST /api/variants/revision-accept
 *
 * Accept a revision-variant proposal. Only the variant owner can accept;
 * acceptance flips comments.revision_status to 'accepted' and returns
 * { target_block_id, accepted_text } so the client can swap the DOM.
 *
 * Persistence of the swap is client-side in the mocks (localStorage keyed
 * `doclayer:revision:<variantId>:<blockId>`). Real Yjs integration is out of
 * scope for v1.
 *
 * Errors:
 *   400 missing/invalid fields
 *   401 unauthorized
 *   403 forbidden (not variant owner)
 *   404 comment not found / not a revision proposal
 *   409 already_finalized (already accepted or rejected)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getServiceClient, getUserFromAuthHeader } from '../../lib/supabase-server.ts';

interface Body {
  comment_id?: string;
  action?: 'accept' | 'reject';
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const user = await getUserFromAuthHeader(req.headers.authorization);
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { res.status(400).json({ error: 'body_not_object' }); return; }
  const body = raw as Body;
  if (typeof body.comment_id !== 'string') { res.status(400).json({ error: 'missing_comment_id' }); return; }
  const action: 'accept' | 'reject' = body.action === 'reject' ? 'reject' : 'accept';

  const supa = getServiceClient();

  // Fetch the proposal — include variant ownership so we can authz inline.
  const q = await supa.from('comments')
    .select('id, variant_id, scenario_id, kind, target_block_id, proposed_text, revision_status')
    .eq('id', body.comment_id)
    .maybeSingle();
  if (q.error || !q.data) { res.status(404).json({ error: 'not_found' }); return; }
  const c = q.data as {
    id: string;
    variant_id: string;
    scenario_id: string;
    kind: string;
    target_block_id: string | null;
    proposed_text: string | null;
    revision_status: string | null;
  };
  if (c.kind !== 'revision_variant') { res.status(404).json({ error: 'not_a_revision_proposal' }); return; }
  if (c.revision_status && c.revision_status !== 'proposed') {
    res.status(409).json({ error: 'already_finalized', revision_status: c.revision_status }); return;
  }

  const vq = await supa.from('variants').select('id, user_id').eq('id', c.variant_id).maybeSingle();
  if (vq.error || !vq.data) { res.status(404).json({ error: 'variant_not_found' }); return; }
  if ((vq.data as { user_id: string }).user_id !== user.id) {
    res.status(403).json({ error: 'forbidden_not_owner' }); return;
  }

  const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
  const upd = await supa.from('comments')
    .update({ revision_status: nextStatus })
    .eq('id', c.id)
    .select('id, revision_status')
    .single();
  if (upd.error || !upd.data) {
    res.status(500).json({ error: 'db_update_failed', detail: upd.error?.message }); return;
  }

  // Audit — append a parallel row so the timeline shows the accept/reject
  // alongside applied patches.
  await supa.from('variant_patches_audit').insert({
    variant_id: c.variant_id,
    patch_id: null,
    user_id: user.id,
    action: action === 'accept' ? 'revision_accepted' : 'revision_rejected',
    detail: {
      comment_id: c.id,
      scenario_id: c.scenario_id,
      target_block_id: c.target_block_id,
    },
  });

  res.status(200).json({
    comment_id: c.id,
    revision_status: nextStatus,
    target_block_id: c.target_block_id,
    accepted_text: action === 'accept' ? c.proposed_text : null,
    scenario_id: c.scenario_id,
    variant_id: c.variant_id,
  });
}
