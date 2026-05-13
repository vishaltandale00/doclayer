/**
 * Smoke tests for lib/auth.ts requireAuth() auto-provisioning behavior.
 *
 * Two cases:
 *  1. First call for a new user: an INSERT lands and returns a fresh variant_id.
 *  2. Subsequent call for the same user: the ON CONFLICT path runs, updating
 *     last_active_at and returning the existing variant_id.
 *
 * We mock the Supabase auth client to return a deterministic user, and we
 * mock lib/db.sqlOne to simulate the upsert returning a variant id. The point
 * is to verify the *contract* of requireAuth (return shape + that it issues
 * the idempotent INSERT) rather than to exercise pg.
 *
 * Requires `--experimental-test-module-mocks`.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---- Mock Supabase auth client ----
const fakeUser = { id: 'user-abc-123', email: 'akhil@example.com' };
mock.module('@supabase/supabase-js', {
  namedExports: {
    createClient: () => ({
      auth: {
        getUser: async (jwt: string) => {
          if (jwt === 'bad') return { data: null, error: { message: 'invalid' } };
          return { data: { user: fakeUser }, error: null };
        },
      },
    }),
  },
});

// ---- Mock lib/db ----
// Track each call so we can assert insert vs. update paths via the returned
// id. We simulate the ON CONFLICT upsert by returning the same id for the
// same (user_id, name) tuple.
const variantStore = new Map<string, string>();
let sqlOneCalls: Array<{ text: string; params: unknown[] }> = [];

mock.module('../../lib/db.ts', {
  namedExports: {
    sql: async () => [],
    sqlOne: async (text: string, params: unknown[]) => {
      sqlOneCalls.push({ text, params });
      const [userId] = params as [string, string];
      const key = `${userId}:main`;
      let id = variantStore.get(key);
      if (!id) {
        id = `variant-${variantStore.size + 1}`;
        variantStore.set(key, id);
      }
      return { id };
    },
    tx: async (fn: (client: any) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [] }) }),
  },
});

// Required env so getSupaAuth() doesn't throw.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:0';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon';

const { requireAuth } = await import('../../lib/auth.ts');

function makeReq(authHeader: string | undefined): any {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

test('requireAuth first call provisions a variant (INSERT path)', async () => {
  sqlOneCalls = [];
  variantStore.clear();
  const result = await requireAuth(makeReq('Bearer good-jwt'));
  assert.ok(!('error' in result), `unexpected error: ${JSON.stringify(result)}`);
  if ('error' in result) return; // type-narrow
  assert.equal(result.user_id, 'user-abc-123');
  assert.equal(result.email, 'akhil@example.com');
  assert.equal(result.email_handle, 'akhil');
  assert.equal(result.variant_id, 'variant-1');
  assert.equal(sqlOneCalls.length, 1);
  // The upsert SQL must contain an ON CONFLICT clause that updates
  // last_active_at — that's the contract we depend on for the second-call
  // case below.
  const sqlText = sqlOneCalls[0].text;
  assert.match(sqlText, /insert into variants/i);
  assert.match(sqlText, /on conflict/i);
  assert.match(sqlText, /last_active_at/i);
});

test('requireAuth second call for same user returns same variant (UPDATE path)', async () => {
  sqlOneCalls = [];
  // Variant for fakeUser already exists from the previous test (variantStore
  // is module-scoped). Calling requireAuth again should hit the ON CONFLICT
  // branch and return the same id.
  const result = await requireAuth(makeReq('Bearer good-jwt'));
  assert.ok(!('error' in result));
  if ('error' in result) return;
  assert.equal(result.variant_id, 'variant-1');
  assert.equal(sqlOneCalls.length, 1, 'still exactly one DB roundtrip per auth call');
});
