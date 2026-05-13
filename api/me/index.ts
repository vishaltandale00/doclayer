/**
 * GET /api/me
 *
 * Lightweight identity hydration endpoint. Validates the JWT and returns
 * the user's variant_id + email_handle. Used by mocks/identity.js to
 * replace the prior direct `supabase.from('variants')` lookup that ran on
 * every session hydrate. Because `requireAuth` idempotently provisions the
 * user's main variant, this also doubles as a defensive bootstrap path
 * (no separate trigger/fallback).
 *
 * Response:
 *   { user_id, email, email_handle, variant_id }
 *
 * Errors:
 *   401 missing_authorization / invalid_jwt
 *   405 method_not_allowed
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../../lib/auth.ts';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req);
  if ('error' in auth) { res.status(auth.status).json({ error: auth.error }); return; }

  res.status(200).json({
    user_id: auth.user_id,
    email: auth.email,
    email_handle: auth.email_handle,
    variant_id: auth.variant_id,
  });
}
