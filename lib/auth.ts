/**
 * JWT verification helper.
 * Verifies a Supabase-issued JWT, returns the user_id + email, and ensures
 * the user's main variant exists in Neon (auto-create-on-first-write, since
 * we can't trigger on auth.users across DBs).
 *
 * Reads:
 *   - SUPABASE_URL + SUPABASE_ANON_KEY: to construct the supabase client.
 *     The anon key is fine here — we're using the user's own JWT for auth,
 *     not the anon key's permissions.
 *
 * Usage in an API handler:
 *   const auth = await requireAuth(req);
 *   if ('error' in auth) return res.status(auth.status).json({ error: auth.error });
 *   const { user_id, email, email_handle, variant_id } = auth;
 */
import { createClient } from '@supabase/supabase-js';
import { sqlOne } from './db.ts';
import type { VercelRequest } from '@vercel/node';

export type AuthOk = {
  user_id: string;
  email: string;
  email_handle: string;
  variant_id: string;
};
export type AuthErr = { error: string; status: number };

let supa: ReturnType<typeof createClient> | null = null;
function getSupaAuth() {
  if (supa) return supa;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
  supa = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supa;
}

export async function requireAuth(req: VercelRequest): Promise<AuthOk | AuthErr> {
  const header = req.headers.authorization || req.headers.Authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.startsWith('Bearer ')) {
    return { error: 'missing_authorization', status: 401 };
  }
  const jwt = raw.slice('Bearer '.length).trim();
  if (!jwt) return { error: 'empty_jwt', status: 401 };

  // Verify JWT by asking Supabase Auth for the user. One HTTP roundtrip,
  // ~20-40ms. Cheaper than rolling our own JWKS verification for now.
  const { data, error } = await getSupaAuth().auth.getUser(jwt);
  if (error || !data?.user) {
    return { error: 'invalid_jwt', status: 401 };
  }
  const user_id = data.user.id;
  const email = data.user.email ?? '';
  if (!email) return { error: 'no_email_claim', status: 401 };
  const email_handle = email.split('@')[0] || email;

  // Ensure the user has a main variant. Idempotent insert.
  // The variants table has UNIQUE(user_id, name); ON CONFLICT no-ops.
  const variant = await sqlOne<{ id: string }>(
    `insert into variants (user_id, name, is_public, email_handle)
     values ($1, 'main', true, $2)
     on conflict (user_id, name) do update
       set last_active_at = now(),
           email_handle = excluded.email_handle
     returning id`,
    [user_id, email_handle]
  );
  if (!variant) return { error: 'variant_provisioning_failed', status: 500 };

  return { user_id, email, email_handle, variant_id: variant.id };
}
