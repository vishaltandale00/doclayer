/**
 * POST /api/variants/regenerate
 *
 * Re-invoke the architect with the current schema + fp when a previously
 * proposed patch has gone stale due to schema rotation. Marks the prior
 * patch row as stale and returns a fresh patch with the current schema_fp.
 *
 * Storage: Neon (Vercel Postgres) via lib/db.ts. The stale-mark + audit
 * write run in a single transaction; the draft-feedback forward happens
 * after the tx commits so a re-invoke failure doesn't undo the staleness
 * bookkeeping.
 *
 * Body: { comment_id: string, prior_patch_id: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { schemaFingerprint } from '../../lib/schema-fp.ts';
import { requireAuth } from '../../lib/auth.ts';
import { tx } from '../../lib/db.ts';
import draftFeedback from '../draft-feedback.ts';

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
  const body = (raw ?? {}) as { comment_id?: string; prior_patch_id?: string };
  if (typeof body.comment_id !== 'string' || typeof body.prior_patch_id !== 'string') {
    res.status(400).json({ error: 'missing_fields' }); return;
  }

  const currentFp = schemaFingerprint(variantSchema as object);

  let forwardCtx: {
    scenario_id: string;
    phase: string | null;
    text: string;
    priorIntent: string;
  };

  try {
    const result = await tx(async (client) => {
      // 1. Load the comment + owning variant (single query).
      const commentRes = await client.query<{
        id: string;
        variant_id: string;
        scenario_id: string;
        phase: string | null;
        text: string;
        owner_user_id: string;
      }>(
        `select c.id, c.variant_id, c.scenario_id, c.phase, c.text,
                v.user_id as owner_user_id
         from comments c
         join variants v on v.id = c.variant_id
         where c.id = $1`,
        [body.comment_id],
      );
      if (commentRes.rowCount === 0) {
        return { kind: 'err' as const, status: 404, body: { error: 'comment_not_found' } };
      }
      const comment = commentRes.rows[0];
      if (comment.owner_user_id !== auth.user_id) {
        return { kind: 'err' as const, status: 403, body: { error: 'forbidden' } };
      }

      // 2. Load the prior patch + cross-check that it belongs to the same
      //    variant we just authorized. Defends against a client passing a
      //    valid comment_id but a prior_patch_id pointing at someone else's
      //    variant.
      const priorRes = await client.query<{
        id: string;
        variant_id: string;
        spec: { intent?: string };
        schema_fp: string;
      }>(
        `select id, variant_id, spec, schema_fp from patches where id = $1`,
        [body.prior_patch_id],
      );
      if (priorRes.rowCount === 0) {
        return { kind: 'err' as const, status: 404, body: { error: 'prior_patch_not_found' } };
      }
      const priorPatch = priorRes.rows[0];
      if (priorPatch.variant_id !== comment.variant_id) {
        return { kind: 'err' as const, status: 403, body: { error: 'forbidden' } };
      }

      const priorIntent = (priorPatch.spec ?? {}).intent ?? '';

      // 3. Mark the prior patch stale. The immutability trigger allows
      //    `stale` (it's not in the immutable column list).
      await client.query(
        `update patches set stale = true where id = $1`,
        [body.prior_patch_id],
      );

      // 4. Audit.
      await client.query(
        `insert into variant_patches_audit
           (variant_id, patch_id, user_id, action, detail)
         values ($1, $2, $3, 'stale', $4::jsonb)`,
        [
          comment.variant_id,
          body.prior_patch_id,
          auth.user_id,
          JSON.stringify({
            reason: 'schema_rotated',
            prior_fp: priorPatch.schema_fp,
            current_fp: currentFp,
          }),
        ],
      );

      return {
        kind: 'ok' as const,
        ctx: {
          scenario_id: comment.scenario_id,
          phase: comment.phase,
          text: comment.text,
          priorIntent,
        },
      };
    });

    if (result.kind === 'err') {
      res.status(result.status).json(result.body);
      return;
    }
    forwardCtx = result.ctx;
  } catch (e) {
    const pgErr = e as { code?: string; message?: string };
    console.error('[doclayer] regenerate tx failed', pgErr);
    res.status(500).json({ error: 'db_error', detail: pgErr.message });
    return;
  }

  // Re-invoke draft-feedback with a contextual note prepended to the comment.
  // The forward runs OUTSIDE the transaction so the architect call (which
  // may take seconds and hit external services) doesn't hold a Postgres
  // connection open, and so its failures don't undo the stale bookkeeping
  // (the client will see the error and can retry; the prior patch stays
  // stale, which is the correct state).
  const augmented = {
    ...req,
    method: 'POST',
    body: {
      scenario: forwardCtx.scenario_id,
      phase: forwardCtx.phase ?? undefined,
      feedback:
        `[regenerate-after-schema-rotation prior_intent="${forwardCtx.priorIntent}"] ` +
        forwardCtx.text,
    },
    headers: req.headers,
  } as unknown as VercelRequest;

  return draftFeedback(augmented, res);
}
