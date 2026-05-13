/**
 * POST /api/comments/post
 *
 * Persist a viewer feedback comment to the Neon `comments` table.
 *
 * This is the persistence-bug fix. The fb-panel fires this BEFORE (or in
 * parallel with) /api/draft-feedback so the comment lands in the DB regardless
 * of whether the architect call succeeds. After /api/draft-feedback returns,
 * the panel may include this `comment_id` so the architect response is
 * UPDATEd onto the same row.
 *
 * Request body:
 *   { scenario, phase?, feedback, anchor? }
 *
 * Response:
 *   { ok: true, comment_id }
 *
 * Errors:
 *   401 missing_authorization / invalid_jwt
 *   405 method_not_allowed
 *   422 invalid_feedback / invalid_scenario
 *   429 rate_limit
 *   500 db_insert_failed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';
import { sqlOne } from '../../lib/db.ts';

// ---- Rate limiting (in-memory, per-user, 10/min) ----
// Mirrors the bucket pattern in revision-propose. Best-effort across cold
// starts. Keyed per-user since the endpoint is authed.
interface Bucket { count: number; resetAt: number; }
const RATE_BUCKET: Map<string, Bucket> = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
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

// Loose scenario validation: kebab-case 1-50 chars. Intentionally not gated by
// a fixed enum here — the architect endpoint already enforces the closed set;
// for persistence we want to log whatever the client sent so the row survives
// a scenario rename without dropping data.
const SCENARIO_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

interface Body {
  scenario?: string;
  phase?: string;
  feedback?: string;
  anchor?: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  const rate = checkRate(auth.user_id);
  if (!rate.ok) {
    const retryAfter = Math.ceil((rate.resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limit', retry_after_seconds: retryAfter });
    return;
  }

  let raw: unknown = req.body;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { res.status(422).json({ error: 'invalid_json' }); return; }
  }
  if (!raw || typeof raw !== 'object') { res.status(422).json({ error: 'body_not_object' }); return; }
  const body = raw as Body;

  if (typeof body.scenario !== 'string' || !SCENARIO_RE.test(body.scenario)) {
    res.status(422).json({ error: 'invalid_scenario' }); return;
  }
  if (typeof body.feedback !== 'string') {
    res.status(422).json({ error: 'invalid_feedback' }); return;
  }
  const feedback = body.feedback.trim();
  if (feedback.length < 3 || feedback.length > 300) {
    res.status(422).json({ error: 'invalid_feedback', detail: 'feedback must be 3-300 chars' });
    return;
  }
  const phase = typeof body.phase === 'string' && body.phase.length <= 50 ? body.phase : null;
  // anchor is optional JSON; default to empty object. Accept anything shaped
  // like an object; reject scalars/arrays so the column always holds a JSON map.
  let anchor: Record<string, unknown> = {};
  if (body.anchor !== undefined && body.anchor !== null) {
    if (typeof body.anchor === 'object' && !Array.isArray(body.anchor)) {
      anchor = body.anchor as Record<string, unknown>;
    } else {
      res.status(422).json({ error: 'invalid_anchor' }); return;
    }
  }

  try {
    const row = await sqlOne<{ id: string }>(
      `insert into comments
         (user_id, variant_id, scenario_id, phase, anchor, text, kind)
       values ($1, $2, $3, $4, $5::jsonb, $6, 'feedback')
       returning id`,
      [auth.user_id, auth.variant_id, body.scenario, phase, JSON.stringify(anchor), feedback]
    );
    if (!row) { res.status(500).json({ error: 'db_insert_failed' }); return; }
    res.status(200).json({ ok: true, comment_id: row.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'db_insert_failed', detail: msg });
  }
}
