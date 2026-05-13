/**
 * POST /api/variants/revision-propose
 *
 * Persist a revision-variant proposal emitted by the architect. The proposal
 * is a prose rewrite anchored to a `data-prose` block — it cannot mutate the
 * variant manifest (prose lives in Yjs sub-docs the DSL doesn't touch).
 *
 * Stored on the `comments` table with kind='revision_variant'. Any signed-in
 * user may propose against a public variant; only the owner can accept
 * (enforced in revision-accept.ts; the RLS policy this replaced was
 * `comments_revision_accept_owner`).
 *
 * Request body:
 *   { variant_id, scenario_id, viewer_comment_id?, target_block_id,
 *     suggested_text, rationale?, intent?, schema_fp?, anchor? }
 *
 * Errors:
 *   400 missing/invalid fields
 *   401 unauthorized
 *   403 forbidden (private variant, not owner)
 *   404 variant_not_found
 *   409 SCHEMA_STALE
 *   429 rate_limit
 *   500 db error
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sql, sqlOne, tx } from '../../lib/db.ts';
import variantSchema from '../../lib/variant-schema.json' with { type: 'json' };
import { schemaFingerprint } from '../../lib/schema-fp.ts';

const VALID_SCENARIOS = new Set<string>([
  '00-flow','01-bootstrap','02-planning','03-drafting','04-review',
  '05-publish','06-reader-harness','07-multiplayer','08-workstream',
  '09-review-loop','index',
]);

const CURRENT_SCHEMA_FP = schemaFingerprint(variantSchema as object);

// ---- Rate limiting (in-memory, per-user, 10/hour) ----
// Best-effort across cold starts: a serverless container recycle loses bucket
// state, so worst case a caller gets a fresh allowance. Acceptable for demo
// scale; for prod-grade we'd back this with a shared store. Keyed per-user
// (not per-IP) because the endpoint is authed.
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

// target_block_id is a data-prose id from the scenario. Restrict to a safe
// charset so we can interpolate it into the audit detail without escaping
// concerns. (We still always use parameterized SQL — this is only a sanity
// guard on input shape.)
const TARGET_BLOCK_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;

interface Body {
  variant_id?: string;
  scenario_id?: string;
  viewer_comment_id?: string;
  target_block_id?: string;
  suggested_text?: string;
  proposed_text?: string; // alias accepted for fwd-compat with spec
  rationale?: string;
  intent?: string;
  anchor?: unknown;
  schema_fp?: string;
}

// NFC normalize. Reject zero-length.
function normalizeProposedText(s: string): string {
  return s.normalize('NFC');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  // Per-user rate limit, 10/hour.
  const rate = checkRate(auth.user_id);
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

  // suggested_text is the canonical wire field; proposed_text accepted as alias
  const rawProposed =
    typeof body.suggested_text === 'string' ? body.suggested_text :
    typeof body.proposed_text === 'string' ? body.proposed_text :
    null;
  if (rawProposed === null) {
    res.status(422).json({ error: 'invalid_suggested_text' }); return;
  }
  const proposedText = normalizeProposedText(rawProposed);
  if (proposedText.length < 1 || proposedText.length > 2000) {
    res.status(422).json({ error: 'invalid_suggested_text', detail: '1-2000 chars after NFC' });
    return;
  }

  const targetBlock = typeof body.target_block_id === 'string' ? body.target_block_id : '';
  if (targetBlock && !TARGET_BLOCK_RE.test(targetBlock)) {
    res.status(422).json({ error: 'invalid_target_block_id' }); return;
  }

  const intent = typeof body.intent === 'string' && body.intent.length <= 300 ? body.intent : 'rewrite proposed';

  // schema_fp pinning. The architect pins schema_fp on the revision-variant
  // envelope; the client forwards it here. We reject a stale fingerprint with
  // 409 SCHEMA_STALE so a long-running session catches a schema bump before
  // persisting a divergent proposal. Backward-compat: callers that omit
  // schema_fp are accepted (and the row stores null) so existing clients keep
  // working until they upgrade.
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

  // Verify variant exists + viewer is allowed to propose. Either the variant
  // is public (any signed-in user may propose) or the caller is the owner.
  const variant = await sqlOne<{ id: string; user_id: string; is_public: boolean }>(
    `select id, user_id, is_public from variants where id = $1`,
    [body.variant_id]
  );
  if (!variant) { res.status(404).json({ error: 'variant_not_found' }); return; }
  if (!variant.is_public && variant.user_id !== auth.user_id) {
    res.status(403).json({ error: 'forbidden' }); return;
  }

  const viewerCommentId = typeof body.viewer_comment_id === 'string' ? body.viewer_comment_id : null;
  // Build the anchor: prefer caller-supplied object, else default to
  // { kind: 'prose-block', target_block_id, comment_id }.
  let anchor: Record<string, unknown>;
  if (body.anchor && typeof body.anchor === 'object' && !Array.isArray(body.anchor)) {
    anchor = { ...(body.anchor as Record<string, unknown>) };
    if (viewerCommentId && anchor.comment_id === undefined) anchor.comment_id = viewerCommentId;
  } else {
    anchor = {
      kind: 'prose-block',
      target_block_id: targetBlock,
      ...(viewerCommentId ? { comment_id: viewerCommentId } : {}),
    };
  }

  const rationale = typeof body.rationale === 'string' ? body.rationale : null;

  try {
    const result = await tx(async (client) => {
      const ins = await client.query<{ id: string }>(
        `insert into comments
           (user_id, variant_id, scenario_id, phase, anchor, text, architect_response,
            routed_kind, kind, target_block_id, proposed_text, revision_status, schema_fp)
         values ($1, $2, $3, NULL, $4::jsonb, $5, $6,
                 'constructive', 'revision_variant', $7, $8, 'proposed', $9)
         returning id`,
        [
          auth.user_id,
          body.variant_id,
          body.scenario_id,
          JSON.stringify(anchor),
          intent,
          rationale,
          targetBlock || null,
          proposedText,
          schemaFpToPersist,
        ]
      );
      const commentId = ins.rows[0]?.id;
      if (!commentId) throw new Error('insert returned no id');

      await client.query(
        `insert into variant_patches_audit
           (variant_id, patch_id, user_id, action, detail)
         values ($1, NULL, $2, 'revision_proposed', $3::jsonb)`,
        [
          body.variant_id,
          auth.user_id,
          JSON.stringify({
            comment_id: commentId,
            scenario_id: body.scenario_id,
            target_block_id: targetBlock || null,
            intent,
          }),
        ]
      );
      return { commentId };
    });

    res.status(200).json({
      comment_id: result.commentId,
      revision_status: 'proposed',
      target_block_id: targetBlock,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_insert_failed', detail: msg });
  }
}

// Re-export rate-limit internals so neighbouring endpoints (e.g. comments/post)
// could share if we ever centralize; kept inline for now to avoid coupling.
export const _internals = { checkRate, RATE_BUCKET };
// Avoid unused import warning when sql() is not used directly here.
void sql;
