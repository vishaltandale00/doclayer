/**
 * POST /api/variants/revision-accept
 *
 * Accept or reject a revision-variant proposal. Only the variant owner can
 * finalize (replaces the Supabase RLS policy `comments_revision_accept_owner`
 * with an app-level check). Acceptance flips comments.revision_status to
 * 'accepted' and returns { target_block_id, accepted_text } so the client can
 * swap the DOM.
 *
 * Request body:
 *   { comment_id, action: 'accept' | 'reject' }
 *
 * Errors:
 *   400 missing/invalid fields
 *   401 unauthorized
 *   403 forbidden_not_owner
 *   404 not_found / variant_not_found
 *   409 already_finalized
 *   422 not_a_revision_proposal
 *   500 db_update_failed
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sqlOne, tx } from '../../lib/db.ts';

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

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(400).json({ error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { res.status(400).json({ error: 'body_not_object' }); return; }
  const body = raw as Body;
  if (typeof body.comment_id !== 'string') { res.status(400).json({ error: 'missing_comment_id' }); return; }
  const action: 'accept' | 'reject' = body.action === 'reject' ? 'reject' : 'accept';

  // Fetch the proposal first so we can do authz + state checks before opening
  // a transaction. The window between this read and the tx UPDATE is small;
  // worst case two owners race an accept → the second sees already_finalized
  // because the UPDATE filters on revision_status='proposed'.
  const c = await sqlOne<{
    id: string;
    variant_id: string;
    scenario_id: string;
    kind: string;
    target_block_id: string | null;
    proposed_text: string | null;
    revision_status: string | null;
  }>(
    `select id, variant_id, scenario_id, kind, target_block_id, proposed_text, revision_status
       from comments where id = $1`,
    [body.comment_id]
  );
  if (!c) { res.status(404).json({ error: 'not_found' }); return; }
  if (c.kind !== 'revision_variant') {
    res.status(422).json({ error: 'not_a_revision_proposal' }); return;
  }
  if (c.revision_status && c.revision_status !== 'proposed') {
    res.status(409).json({ error: 'already_finalized', revision_status: c.revision_status });
    return;
  }

  const variant = await sqlOne<{ id: string; user_id: string }>(
    `select id, user_id from variants where id = $1`,
    [c.variant_id]
  );
  if (!variant) { res.status(404).json({ error: 'variant_not_found' }); return; }
  if (variant.user_id !== auth.user_id) {
    res.status(403).json({ error: 'forbidden_not_owner' }); return;
  }

  const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
  const auditAction = action === 'accept' ? 'revision_accepted' : 'revision_rejected';

  try {
    const finalStatus = await tx(async (client) => {
      // Guarded UPDATE: only flip if still 'proposed'. Handles racing
      // accept/reject from two windows of the same owner.
      const upd = await client.query<{ id: string; revision_status: string }>(
        `update comments
            set revision_status = $2
          where id = $1 and revision_status = 'proposed'
          returning id, revision_status`,
        [c.id, nextStatus]
      );
      if (upd.rowCount === 0) {
        throw new RaceError();
      }

      await client.query(
        `insert into variant_patches_audit
           (variant_id, patch_id, user_id, action, detail)
         values ($1, NULL, $2, $3, $4::jsonb)`,
        [
          c.variant_id,
          auth.user_id,
          auditAction,
          JSON.stringify({
            comment_id: c.id,
            scenario_id: c.scenario_id,
            target_block_id: c.target_block_id,
          }),
        ]
      );
      return upd.rows[0].revision_status;
    });

    res.status(200).json({
      comment_id: c.id,
      revision_status: finalStatus,
      target_block_id: c.target_block_id,
      accepted_text: action === 'accept' ? c.proposed_text : null,
      scenario_id: c.scenario_id,
      variant_id: c.variant_id,
    });
  } catch (e) {
    if (e instanceof RaceError) {
      res.status(409).json({ error: 'already_finalized' });
      return;
    }
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_update_failed', detail: msg });
  }
}

class RaceError extends Error {
  constructor() { super('race: comment was finalized concurrently'); }
}
