/**
 * Server-side Supabase helpers for variant API routes.
 *
 * We use the service-role key for privileged transactions (insert into
 * variant_doc_versions, variant_patches_audit; supersession bookkeeping)
 * after we've authenticated the caller via the JWT in the Authorization
 * header.
 *
 * Env required at runtime:
 *   SUPABASE_URL                 — project URL
 *   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT (server only)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('supabase-server: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  serviceClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return serviceClient;
}

export interface AuthedUser {
  id: string;
  email?: string;
}

/**
 * Pull the JWT from the Authorization header, verify it via the auth admin
 * API (or with the anon client's getUser), return the user. Returns null on
 * any failure — caller emits 401.
 */
export async function getUserFromAuthHeader(
  authHeader: string | undefined,
): Promise<AuthedUser | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const jwt = m[1];
  try {
    const c = getServiceClient();
    const { data, error } = await c.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? undefined };
  } catch {
    return null;
  }
}
